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
        // ⚠️ userId 必须出现在签名里。它是 Views/Adoption/Index.cshtml 那个
        //    `<form asp-controller="Payment" asp-action="MakePayment" method="post">`
        //    提交的**表单字段**（实测提交的是 petid / pettype / peturl / userId /
        //    __RequestVerificationToken），所以只能靠模型绑定从 body 取。
        //
        //    我第一版写成 `Request.Query["userId"]` —— 那是**查询串**，POST 表单里
        //    取不到，结果拿到空串，下游收到 `?...&userId=` 仍然 400。
        //    症状极具误导性：页面正常显示 "Adoption Complete / Thank you for
        //    adopting me!"，而后端 availability 没变、数据库没落交易 ——
        //    因为 PostTransaction 的失败被外层 catch 吞掉，txStatus 仍是 success。
        //    日志里能看到 `POST /api/completeadoption?petId=022&petType=kitten&userId=`
        //    后面是空的，那是唯一的线索。
        public async Task<IActionResult> MakePayment(string petId, string pettype, string userId)
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

                var result = await PostTransaction(petId, pettype, userId);
                AWSXRayRecorder.Instance.EndSubsegment();

                // ⚠️ 必须检查响应码。原实现拿到 result 却**从不看 IsSuccessStatusCode**，
                //    于是 payforadoption 返回 400 也照样往下走，txStatus 保持 "success"，
                //    页面显示「Adoption Complete / Thank you for adopting me!」
                //    而后端 availability 没变、数据库没落交易 —— 一个彻底的假成功。
                //
                //    实测过这个假成功：日志里
                //      POST /api/completeadoption?petId=022&petType=kitten&userId= → 400
                //    而用户看到的是领养完成页。这类 bug 从前端完全无法察觉，
                //    只有比对后端状态才会暴露。
                if (!result.IsSuccessStatusCode)
                {
                    var body = await result.Content.ReadAsStringAsync();
                    throw new HttpRequestException(
                        $"payforadoption returned {(int)result.StatusCode} for petId={petId} " +
                        $"pettype={pettype} userId={userId}: {body}");
                }

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

        private async Task<HttpResponseMessage> PostTransaction(string petId, string pettype, string userId)
        {
            // ⚠️ userId 是**必填**的。payforadoption 的 decodeCompleteAdoptionRequest
            //    （transport.go:100-108）三个查询参数缺一即返回 ErrBadRequest：
            //      if petId == "" || petType == "" || userID == "" { return nil, ErrBadRequest }
            //    原实现只传 petId 与 petType，导致**每次点「领养」都 400**。
            //    实测：不带 userId 返回 400 {"error":"bad request"}；
            //          带上 userId 返回 200 + 交易 ID，宠物 availability 转为 no，
            //          数据库落新行且 pet_type / user_id 两列均正确写入。
            //
            //    这个不一致来自上游移植（9f2bffbd）：服务端新增了 userID 必填校验，
            //    而 petsite 侧的调用没跟上。
            //
            //    userId 由调用方经**模型绑定从表单体**取得并传进来 ——
            //    不要在这里读 Request.Query，那是查询串，POST 表单里是空的。
            if (string.IsNullOrWhiteSpace(userId))
            {
                // 显式失败而不是发一个注定 400 的请求：
                // 静默发出去会让页面显示「Adoption Complete」而后端什么都没做，
                // 这种假成功比直接报错难查得多。
                throw new ArgumentException(
                    "userId is required by payforadoption /api/completeadoption; " +
                    "it must come from the Adoption form's hidden userId field.");
            }

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