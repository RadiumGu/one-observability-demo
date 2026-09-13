using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using PetSite.Configuration;

namespace PetSite.Controllers
{
    /// <summary>
    /// 健康端点。**liveness 与 readiness 刻意分开，语义不同。**
    ///
    /// <para>
    /// <c>/health/status</c>（liveness）—— 只回答「这个进程还活着吗」，
    /// 不检查任何下游或配置。liveness **绝不可以**依赖下游：一次下游故障会让
    /// kubelet 杀掉每一个 Pod，把一个局部故障放大成全站不可用。这是级联失败的
    /// 教科书反模式。
    /// </para>
    ///
    /// <para>
    /// <c>/health/ready</c>（readiness）—— 回答「这个 Pod 现在能不能服务请求」。
    /// readiness **可以**依赖配置与下游，因为它只影响是否把流量路由进来。
    /// </para>
    ///
    /// <para>
    /// 为什么需要加这个端点（2026-09-13 实测）：原先 startup / readiness /
    /// liveness 三个探针**全部**指向 <c>/health/status</c>，而它返回字面量
    /// "Alive"、什么都不检查。于是 HPA 扩容出的新 Pod 在 ASP.NET 刚能响应 HTTP
    /// 时就被标记 Ready，此时 SSM 参数还没解析完、对 petsearch 的调用还不通，
    /// ALB 已经把流量打进来 —— 返回一个渲染正常但**没有任何宠物**的首页
    /// （10,720 字符 vs 正常 221,000 字符）。
    /// </para>
    ///
    /// <para>
    /// 实测相关性：新 Pod 15:54:54 变 Ready，合成流量探针 15:55:42 拿到空首页，
    /// 相距 48 秒。当时的临时缓解是给 readinessProbe 加
    /// <c>initialDelaySeconds: 45</c>（Pod 就绪时间从 15s 变 55s），
    /// 但那只是猜一个够长的延迟；本端点是真修 —— 它检查的是**实际就绪状态**
    /// 而不是「等够久了大概就好了」。
    /// </para>
    ///
    /// <para>
    /// 只查配置解析、不对下游发真实请求：readiness 每 5 秒探一次，
    /// 若每次都打一遍 petsearch，等于给下游凭空加一份与副本数成正比的负载，
    /// 而且下游抖动会让整批 Pod 同时被摘出 —— 又变成级联失败。
    /// 配置能解析 = SSM 可达且参数已缓存，这已经覆盖了实测到的那个失效窗口。
    /// </para>
    /// </summary>
    public class HealthController : Controller
    {
        private readonly ParameterRefreshManager _refreshManager;
        private readonly ILogger<HealthController> _logger;

        public HealthController(ParameterRefreshManager refreshManager,
                               ILogger<HealthController> logger)
        {
            _refreshManager = refreshManager;
            _logger = logger;
        }

        /// <summary>liveness —— 进程活着即返回，不检查下游。见类注释。</summary>
        [HttpGet("/health/status")]
        public string Status()
        {
            return "Alive";
        }

        /// <summary>
        /// readiness —— 交付首页所必需的配置是否都已解析。
        /// 任一项缺失返回 503，kubelet 会把该 Pod 从 Service 端点里摘掉。
        /// </summary>
        [HttpGet("/health/ready")]
        public async Task<IActionResult> Ready()
        {
            // 首页要能渲染出宠物，最少需要这两项：搜索 API 与支付 API。
            // 刻意不把全部参数都列进来 —— 与首页无关的参数缺失不该阻止就绪，
            // 那会让一个次要功能的配置问题拖垮主路径。
            var required = new (string Name, string Key)[]
            {
                ("search_api", ParameterNames.SEARCH_API_URL),
                ("payment_api", ParameterNames.PAYMENT_API_URL),
            };

            var checks = new Dictionary<string, string>();
            var ready = true;

            foreach (var (name, key) in required)
            {
                try
                {
                    var value = await ParameterNames.GetParameterValueAsync(key, _refreshManager);
                    var resolved = !string.IsNullOrWhiteSpace(value);
                    checks[name] = resolved ? "resolved" : "empty";
                    if (!resolved) ready = false;
                }
                catch (Exception e)
                {
                    // 记下异常类型而不是整条消息 —— 健康端点的响应体可能被
                    // 日志与监控大量采集，不该把连接串一类的细节漏出去。
                    checks[name] = "error:" + e.GetType().Name;
                    ready = false;
                }
            }

            if (!ready)
            {
                _logger.LogWarning("Readiness check failed: {Checks}",
                                   string.Join(",", checks));
                return StatusCode(503, new { status = "NotReady", checks });
            }

            return Ok(new { status = "Ready", checks });
        }
    }
}
