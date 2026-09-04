using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using System;
using System.Net.Http;
using System.Threading.Tasks;
using Amazon.XRay.Recorder.Core;
using Amazon.XRay.Recorder.Handlers.System.Net;
using Amazon.XRay.Recorder.Handlers.AwsSdk;


namespace PetSite.Controllers
{
    public class PetFoodController : Controller
    {
        
        private static HttpClient httpClient;
        private IConfiguration _configuration;
        
        public PetFoodController(IConfiguration configuration)
        {
            _configuration = configuration;
        }

        [HttpGet("/petfood")]
        public async Task<string> Index()
        {
            // X-Ray FTW
            AWSXRayRecorder.Instance.BeginSubsegment("Calling PetFood");
            try
            {
                Console.WriteLine($"[{AWSXRayRecorder.Instance.GetEntity().TraceId}][{AWSXRayRecorder.Instance.TraceContext.GetEntity().RootSegment.TraceId}] - Calling PetFood");
            }
            catch (Amazon.XRay.Recorder.Core.Exceptions.EntityNotAvailableException) { /* trace context not available, safe to skip */ }
            
            // Get our data from petfood
            var httpClient = new HttpClient(new HttpClientXRayTracingHandler(new HttpClientHandler()));

            // ⚠️ 原本是硬编码的 `http://petfood`（根路径）。
            //    那在**旧** petfood 服务上能工作，但新的 petfood-rs 只注册了
            //    /api/foods、/api/cart/:user_id、/health/status、/metrics ——
            //    **没有 `/` 路由**，请求根路径直接 404。
            //    症状是 /petfood 页面显示
            //      "Oops! Something went wrong
            //       Error: Response status code does not indicate success: 404 (Not Found)."
            //    而 petfood 自身完全健康（2/2 Ready、配置全部解析成功）。
            //
            //    这是「保留本地遗留桩」的真实代价：它的埋点值得保（X-Ray subsegment），
            //    但它的硬编码地址与新服务不兼容。
            //
            //    改为走 SSM 参数而不是继续硬编码 —— 地址由 CDK/运维统一管理，
            //    与 FoodServiceController 读的是**同一个** /petstore/petfoodapiurl，
            //    不会再出现两处地址不同步。
            //    取不到参数时回落到集群内 DNS + 正确路径，保证降级而非崩溃。
            var petFoodUrl = _configuration["petfoodapiurl"];
            if (string.IsNullOrEmpty(petFoodUrl))
            {
                petFoodUrl = "http://petfood.petadoptions.svc.cluster.local/api/foods";
            }
            string result = await httpClient.GetStringAsync(petFoodUrl);
            
            // Close the segment
            AWSXRayRecorder.Instance.EndSubsegment();
            
            // Return the result!
            return result;
        }
        
        [HttpGet("/petfood-metric/{entityId}/{value}")]
        public async Task<string> PetFoodMetric(string entityId, float value)
        {
            // X-Ray FTW
            AWSXRayRecorder.Instance.BeginSubsegment("Calling PetFood metric");
            Console.WriteLine("Calling: " + "http://petfood-metric/metric/" + entityId + "/" + value.ToString());
            try
            {
                Console.WriteLine($"[{AWSXRayRecorder.Instance.GetEntity().TraceId}][{AWSXRayRecorder.Instance.TraceContext.GetEntity().RootSegment.TraceId}] - Calling PetFood metric");
            }
            catch (Amazon.XRay.Recorder.Core.Exceptions.EntityNotAvailableException) { /* trace context not available, safe to skip */ }
            
            var httpClient = new HttpClient(new HttpClientXRayTracingHandler(new HttpClientHandler()));
            string result = await httpClient.GetStringAsync("http://petfood-metric/metric/" + entityId + "/" + value.ToString());

            AWSXRayRecorder.Instance.AddAnnotation("entityId", entityId);
            AWSXRayRecorder.Instance.AddAnnotation("value", value.ToString());
            AWSXRayRecorder.Instance.EndSubsegment();
            
            return result;
        }

    }
}