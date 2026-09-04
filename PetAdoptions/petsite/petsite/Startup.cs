using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.HttpsPolicy;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Amazon.Extensions.NETCore.Setup;
using Amazon;
using Prometheus;
using PetSite.Middleware;
using Amazon.XRay.Recorder.Handlers.AwsSdk;


namespace PetSite
{
    public class Startup
    {
        public Startup(IConfiguration configuration)
        {
            Configuration = configuration;
            new ConfigurationBuilder()
                .AddEnvironmentVariables()
                .Build();
        }

        public IConfiguration Configuration { get; }

        // This method gets called by the runtime. Use this method to add services to the container.
        public void ConfigureServices(IServiceCollection services)
        {
            // ⚠️ 保留本地：给所有 AWS SDK 调用注册 X-Ray（在启动时一次，而非每个 controller 里）。
            //    上游删掉了它，因为上游改用 ADOT 自动埋点 + OpenTelemetry Activity API。
            //    但本环境 petsite 是**单容器、无 aws-otel-collector sidecar**（2026-08-29 撤回），
            //    遥测出口是集群级 `xray-daemon` DaemonSet（UDP 2000）—— 只认 X-Ray SDK。
            //    删掉这行 = petsite 从 X-Ray 服务图消失 = etl_xray 丢掉它的全部出边。
            AWSSDKHandler.RegisterXRayForAllServices();

            // ⚠️ 保留本地：DataProtection 密钥持久化到 SSM。
            //    上游 Startup.cs 里 DataProtection 命中数为 0，即完全去掉。
            //    去掉后密钥落容器本地文件系统 —— **2 个副本间不共享、Pod 重启即丢**，
            //    防伪令牌与会话在请求打到另一副本时失效。
            //    线上 SSM 的 `/petstore/dataprotection/key-*` 参数就是它写的，是活着的机制。
            services.AddDataProtection()
                .PersistKeysToAWSSystemsManager("/petstore/dataprotection");

            services.AddControllersWithViews();

            // ── 以下 5 项为上游新增，本次移植一并采纳 ──
            services.AddHttpClient();
            services.AddHttpContextAccessor();
            services.AddScoped<PetSite.Services.IPetSearchService, PetSite.Services.PetSearchService>();

            // Configure AWS Services - using default credential chain for Pod Identity
            services.AddAWSService<Amazon.SimpleSystemsManagement.IAmazonSimpleSystemsManagement>();

            // Register Bedrock Agent Core as Singleton to reuse connections
            // —— 这是 petsite 与 AgentCore 的集成入口（WaggleController 用它）
            services.AddSingleton<Amazon.BedrockAgentCore.IAmazonBedrockAgentCore>(sp =>
            {
                var awsOptions = new AWSOptions();
                return awsOptions.CreateServiceClient<Amazon.BedrockAgentCore.IAmazonBedrockAgentCore>();
            });

            // Register parameter refresh manager as singleton
            // —— 取代本地已删除的 SystemsManagerConfigurationProviderWithReload.cs
            services.AddSingleton<PetSite.Configuration.ParameterRefreshManager>();
        }

        // This method gets called by the runtime. Use this method to configure the HTTP request pipeline.
        public void Configure(IApplicationBuilder app, IWebHostEnvironment env)
        {
            // ⚠️ 保留本地：X-Ray 的 ASP.NET Core 中间件，负责为每个入站请求开 segment。
            //    没有它，上面 RegisterXRayForAllServices 产生的 subsegment 会因为
            //    缺少父 segment 而丢弃（本地 PaymentController 里那句
            //    `catch (EntityNotAvailableException)` 就是在防这种情况）。
            //    必须在其余中间件之前 —— 否则请求早期的处理不在 trace 里。
            app.UseXRay("PetSite", Configuration);

            if (env.IsDevelopment())
            {
                // 采纳上游：统一错误处理中间件，取代 UseDeveloperExceptionPage / UseExceptionHandler
                app.UseMiddleware<ErrorHandlingMiddleware>();
            }
            else
            {
                app.UseMiddleware<ErrorHandlingMiddleware>();
                app.UseHsts();
            }

            app.UseHttpsRedirection();
            app.UseStaticFiles();

            app.UseRouting();
            app.UseHttpMetrics();

            app.UseAuthorization();

            app.UseEndpoints(endpoints =>
            {
                endpoints.MapControllerRoute(
                    name: "default",
                    pattern: "{controller=Home}/{action=Index}/{id?}");
                endpoints.MapMetrics();
            });
        }
    }
}
