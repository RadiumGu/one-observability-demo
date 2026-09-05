using System;
using System.Collections.Generic;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading.Tasks;
using Amazon.XRay.Recorder.Core;
using Amazon.XRay.Recorder.Handlers.AwsSdk;
using Amazon.XRay.Recorder.Handlers.System.Net;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Amazon.SQS;
using Amazon.SQS.Model;
using System.Text.Json.Serialization;
using System.Text.Json;
using Amazon;
using Amazon.Runtime;
using Amazon.SimpleNotificationService;
using Amazon.SimpleNotificationService.Model;
using Amazon.StepFunctions;
using Amazon.StepFunctions.Model;
using Microsoft.Extensions.Configuration;
using PetSite.Models;
using Prometheus;
using Newtonsoft;

namespace PetSite.Controllers
{
    public class PaymentController : Controller
    {
        private static string _txStatus = String.Empty;

        private static HttpClient _httpClient =
            new HttpClient(new HttpClientXRayTracingHandler(new HttpClientHandler()));

        private static AmazonSQSClient _sqsClient;
        private static IConfiguration _configuration;

        //Prometheus metric to count the number of Pets adopted
        private static readonly Counter PetAdoptionCount =
            Metrics.CreateCounter("petsite_petadoptions_total", "Count the number of Pets adopted");

        public PaymentController(IConfiguration configuration)
        {
            _configuration = configuration;

            var region = RegionEndpoint.GetBySystemName(
                Environment.GetEnvironmentVariable("AWS_REGION") ?? "ap-northeast-1");
            _sqsClient = new AmazonSQSClient(region);
        }

        // GET: Payment
        [HttpGet]
        private ActionResult Index()
        {
            return View();
        }

        // POST: Payment/MakePayment
        [HttpPost]
        // [ValidateAntiForgeryToken]
        public async Task<IActionResult> MakePayment(string petId, string pettype)
        {
            ViewData["txStatus"] = "success";

            try
            {
                AWSXRayRecorder.Instance.BeginSubsegment("Call Payment API");

                // Fix: AddMetadata after BeginSubsegment; GetEntity wrapped with try-catch
                AWSXRayRecorder.Instance.AddMetadata("PetType", pettype);
                AWSXRayRecorder.Instance.AddMetadata("PetId", petId);

                try
                {
                    Console.WriteLine(
                        $"[{AWSXRayRecorder.Instance.TraceContext.GetEntity().RootSegment.TraceId}][{AWSXRayRecorder.Instance.GetEntity().TraceId}] - Inside MakePayment Action method - PetId:{petId} - PetType:{pettype}");
                }
                catch (Amazon.XRay.Recorder.Core.Exceptions.EntityNotAvailableException) { /* trace context not available, safe to skip */ }

                AWSXRayRecorder.Instance.AddAnnotation("PetId", petId);
                AWSXRayRecorder.Instance.AddAnnotation("PetType", pettype);

                var result = await PostTransaction(petId, pettype);
                AWSXRayRecorder.Instance.EndSubsegment();

                AWSXRayRecorder.Instance.BeginSubsegment("Post Message to SQS");
                var messageResponse = PostMessageToSqs(petId, pettype).Result;
                AWSXRayRecorder.Instance.EndSubsegment();

                AWSXRayRecorder.Instance.BeginSubsegment("Send Notification");
                var snsResponse = SendNotification(petId).Result;
                AWSXRayRecorder.Instance.EndSubsegment();

                if ("bunny" == pettype) // Only call StepFunction for "bunny" pettype to reduce number of invocations
                {
                   // Console.WriteLine($"STEPLOG- PETTYPE- {pettype}");
                    //   AWSXRayRecorder.Instance.BeginSubsegment("Start Step Function");
                    var stepFunctionResult = StartStepFunctionExecution(petId, pettype).Result;
                    //Console.WriteLine($"STEPLOG - RESPONSE - {stepFunctionResult.HttpStatusCode}");
                    //    AWSXRayRecorder.Instance.EndSubsegment();
                }

                //Increase purchase metric count
                PetAdoptionCount.Inc();
                return View("Index");
            }
            catch (Exception ex)
            {
                ViewData["txStatus"] = "failure";
                ViewData["error"] = ex.Message;
                AWSXRayRecorder.Instance.AddException(ex);
                return View("Index");
            }
        }

        private async Task<HttpResponseMessage> PostTransaction(string petId, string pettype)
        {
            // ⚠️ userId 是**必填**的。payforadoption 的 decodeCompleteAdoptionRequest
            //    （transport.go:100-108）三个查询参数缺一即返回 ErrBadRequest：
            //      if petId == "" || petType == "" || userID == "" { return nil, ErrBadRequest }
            //    原实现只传 petId 与 petType，导致**每次点「领养」都 400**。
            //    实测：不带 userId 返回 400 {"error":"bad request"}；
            //          带上 userId 返回 200 + 交易 ID，且宠物 availability 转为 no。
            //
            //    这个不一致来自上游移植（9f2bffbd）：服务端新增了 userID 必填校验，
            //    而 petsite 侧的调用没跟上。日志里能看到 petsite Pod 自己的 IP
            //    在持续打这个端点并持续 400 —— 失败方与发起方是同一个服务。
            //
            //    userId 由 BaseController 从查询串取（见 BaseController.EnsureUserId），
            //    首页会在缺失时生成并重定向，所以这里总能拿到值。
            var userId = Request.Query["userId"].ToString();
            var url = $"{_configuration["paymentapiurl"]}?petId={Uri.EscapeDataString(petId)}"
                      + $"&petType={Uri.EscapeDataString(pettype)}"
                      + $"&userId={Uri.EscapeDataString(userId)}";
            return await _httpClient.PostAsync(url, null);
        }

        private async Task<SendMessageResponse> PostMessageToSqs(string petId, string petType)
        {
            AWSSDKHandler.RegisterXRay<IAmazonSQS>();

            return await _sqsClient.SendMessageAsync(new SendMessageRequest()
            {
                MessageBody = JsonSerializer.Serialize($"{petId}-{petType}"),
                QueueUrl = _configuration["queueurl"]
            });
        }

        private async Task<StartExecutionResponse> StartStepFunctionExecution(string petId, string petType)
        {
            /*
             
             // Code to invoke StepFunction through API Gateway
             var stepFunctionInputModel = new StepFunctionInputModel()
            {
                input = JsonSerializer.Serialize(new SearchParams() {petid = petId, pettype = petType}),
                name = $"{petType}-{petId}-{Guid.NewGuid()}",
                stateMachineArn = _configuration["petadoptionsstepfnarn"]
            };
            
            var content = new StringContent(
                JsonSerializer.Serialize(stepFunctionInputModel),
                Encoding.UTF8,
                "application/json");

            return await _httpClient.PostAsync(_configuration["petadoptionsstepfnurl"], content);
            
            */
           // Console.WriteLine($"STEPLOG -ARN - {_configuration["petadoptionsstepfnarn"]}");
            //Console.WriteLine($"STEPLOG - SERIALIZE - {JsonSerializer.Serialize(new SearchParams() {petid = petId, pettype = petType})}");
            AWSSDKHandler.RegisterXRay<IAmazonStepFunctions>();
            return await new AmazonStepFunctionsClient().StartExecutionAsync(new StartExecutionRequest()
            {
                Input = JsonSerializer.Serialize(new SearchParams() {petid = petId, pettype = petType}),
                Name = $"{petType}-{petId}-{Guid.NewGuid()}",
                StateMachineArn = _configuration["petadoptionsstepfnarn"]
            });
        }

        private async Task<PublishResponse> SendNotification(string petId)
        {
            AWSSDKHandler.RegisterXRay<IAmazonService>();

            var snsClient = new AmazonSimpleNotificationServiceClient();
            return await snsClient.PublishAsync(topicArn: _configuration["snsarn"],
                message: $"PetId {petId} was adopted on {DateTime.Now}");
        }
    }
}