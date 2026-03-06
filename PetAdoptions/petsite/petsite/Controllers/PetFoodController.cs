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
            string result = await httpClient.GetStringAsync("http://petfood");
            
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