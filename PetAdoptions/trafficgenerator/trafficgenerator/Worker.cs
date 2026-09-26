using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace trafficgenerator
{
    public class Worker : BackgroundService
    {
        private readonly ILogger<Worker> _logger;
        
        private HttpClient _httpClient;
        private List<Pet> _allPets;
        private string _petSiteUrl;
        private string _petSearchUrl;
        private string _trafficdelaytime;

        public Worker(ILogger<Worker> logger, IConfiguration configuration)
        {
            _logger = logger;

            var handler = new HttpClientHandler
            {
                // Allow self-signed certs (ALB may use ACM cert not in container trust store)
                ServerCertificateCustomValidationCallback = HttpClientHandler.DangerousAcceptAnyServerCertificateValidator
            };
            _httpClient = new HttpClient(handler);
            
            // Add custom header for ALB rule to bypass Cognito auth
            var trafficHeader = configuration["TRAFFIC_GENERATOR_HEADER"];
            if (!string.IsNullOrEmpty(trafficHeader))
            {
                var parts = trafficHeader.Split(':', 2);
                if (parts.Length == 2)
                {
                    _httpClient.DefaultRequestHeaders.Add(parts[0], parts[1]);
                    logger.LogInformation($"Added traffic header: {parts[0]}");
                }
            }
            
            _petSiteUrl = configuration["petsiteurl"];
            _petSearchUrl = configuration["searchapiurl"];
            _trafficdelaytime = configuration["trafficdelaytime"];
            
        }

        protected override async Task ExecuteAsync(CancellationToken stoppingToken)
        {
            while (!stoppingToken.IsCancellationRequested)
            {
                try
                {
                    _logger.LogInformation("Worker running at: {time}", DateTimeOffset.Now);

                    await ThrowSomeTrafficIn();

                    Int32.TryParse(_trafficdelaytime, out int delaytime);

                    delaytime = delaytime == 0 ? 1 : delaytime;
                    
                    _logger.LogInformation($"Delay time : {delaytime * 20} seconds");
                    
                    await Task.Delay(delaytime * 20000, stoppingToken);
                }
                catch (Exception e)
                {
                    Console.WriteLine(e.Message);
                    _logger.LogCritical(e.Message);
                    await Task.Delay(100000, stoppingToken);
                }
            }
        }

        private async Task LoadPetData()
        {
          //  Console.WriteLine($"Search URL: {_petSearchUrl}");
          
          // Loads the Petdata from DynamoDB into memory
            _allPets = JsonSerializer.Deserialize<List<Pet>>(
                await _httpClient.GetStringAsync(_petSearchUrl));
        }

        private async Task ThrowSomeTrafficIn()
        {
            _logger.LogInformation("Synchronous Housekeeping call");
            // Performs housekeeping. Basically, reset the application data and gets ready for the execution cycle
            _httpClient.GetAsync(
                $"{_petSiteUrl}/housekeeping/").Wait();
            
            _logger.LogInformation("Starting Async LoadPetData");

            await LoadPetData();

            _logger.LogInformation($"Total number of pets - {_allPets.Count}");
            Random random = new Random();
            var loadSize = random.Next(5, _allPets.Count);

         //   Console.WriteLine($"PetSite URL: {_petSiteUrl}");

            if (loadSize > 20)
            {
                await _httpClient.DeleteAsync($"{_petSiteUrl}/pethistory/deletepetadoptionshistory");
                _logger.LogInformation("Deleted PetAdoptions History");
            }
            else
            {
                await _httpClient.GetAsync($"{_petSiteUrl}/pethistory");
            }

            
            for (int i = 0; i < loadSize; i++)
            {
                var currentPet = _allPets[random.Next(0, _allPets.Count - 1)];

             //   Console.WriteLine($"Searching: {_petSiteUrl}/?selectedPetType={currentPet.pettype}&selectedPetColor={currentPet.petcolor}");
                
             //Performs a search query   
             await _httpClient.GetAsync(
                    $"{_petSiteUrl}/?selectedPetType={currentPet.pettype}&selectedPetColor={currentPet.petcolor}");

             // Performs the "TakeMeHome" action on the current Pet in context  
             await _httpClient.PostAsync($"{_petSiteUrl}/Adoption/TakeMeHome",
                    new StringContent(
                        $"pettype={currentPet.pettype}&" +
                        $"petcolor={currentPet.petcolor}&" +
                        $"petid={currentPet.petid}",
                        Encoding.Default, "application/x-www-form-urlencoded"));

             // Completes adoption by making the payment
                //
                // ⚠️ userId 是**必填**的，不能省。
                //
                //    payforadoption 的 decodeCompleteAdoptionRequest 三个查询参数
                //    缺一即返回 400（petId / petType / userID）。而 petsite 的
                //    MakePayment 从**表单体**做模型绑定取 userId —— 所以这里不带，
                //    整条领养链路就到不了支付后端。
                //
                //    实测（2026-09-26，修复 ca60bc8f 上线后）：
                //      不带 userId → 页面 "Sorry, something went wrong"
                //      带   userId → 页面 "Adoption Complete"，transactions 落行
                //
                //    在 ca60bc8f 之前，不带 userId 的表现是**假成功**：
                //    页面显示「Adoption Complete」而后端一行没写，HTTP 200 零异常。
                //    那次东京线上的实测比例是 3574 次尝试对 104 次真正落库（2.9%），
                //    也就是说这个 demo 展示的领养链路追踪，97% 是假的 ——
                //    没有 payforadoption 段、没有 Aurora 段、没有 SQS 段。
                //
                //    用固定的 "traffic-generator" 而不是随机值：
                //    它要能在追踪与日志里和合成金丝雀（synthetic-adoption）
                //    以及真实用户区分开，否则排查时分不清流量来源。
                await _httpClient.PostAsync($"{_petSiteUrl}/Payment/MakePayment",
                    new StringContent(
                        $"pettype={currentPet.pettype}&" +
                        $"petid={currentPet.petid}&" +
                        $"userId=traffic-generator",
                        Encoding.Default, "application/x-www-form-urlencoded"));

                // Lists all adopted pets
                await _httpClient.GetAsync(
                    $"{_petSiteUrl}/PetListAdoptions");
            }


        }
    }
}