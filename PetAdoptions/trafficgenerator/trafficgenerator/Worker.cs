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
        // 每轮领养上限。见 ThrowSomeTrafficIn 里那段说明 ——
        // 它防的是「领养链路修好之后目录被领养光、ValidatePet 开始拒绝」这个自限循环。
        private string _maxAdoptionsPerCycle;

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
            _maxAdoptionsPerCycle = configuration["maxadoptionspercycle"];
            
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

            // ⚠️ random.Next(5, n) 在 n <= 5 时抛 ArgumentOutOfRangeException。
            //    目前不会触发（/api/search 返回全部 26 只，不分可用性），
            //    但一旦 search 改成只返回可领养的，这里会在某个半夜炸掉。
            var picked = random.Next(5, Math.Max(6, _allPets.Count));

         //   Console.WriteLine($"PetSite URL: {_petSiteUrl}");

            // ⚠️ 这个分支必须用**未截断的** picked，不是下面那个 loadSize。
            //    它决定的是「要不要清理领养历史」，与每轮领养多少只是两件事。
            //    改用截断后的值会让上限小于 20 时这条路径**永远不走** ——
            //    那是一个没人会注意到的行为改变（历史从此不再被清理）。
            if (picked > 20)
            {
                await _httpClient.DeleteAsync($"{_petSiteUrl}/pethistory/deletepetadoptionshistory");
                _logger.LogInformation("Deleted PetAdoptions History");
            }
            else
            {
                await _httpClient.GetAsync($"{_petSiteUrl}/pethistory");
            }

            
            // ── 每轮领养上限 ──────────────────────────────────────────────
            // 为什么需要它（2026-09-27 实测的一个自限循环）：
            //
            //   ① 补货（housekeeping）只在每轮开头做一次
            //   ② 随后一轮领养 5..25 只（26 只目录里几乎全部）
            //   ③ payforadoption 的 ValidatePet 会去问 search-service
            //      这只宠物是否可领养，非 200 就在 CreateTransaction **之前**返回
            //   ④ 而 traffic-generator 从 /api/search 取到的是**全部 26 只**
            //      （不分可用性），所以目录被领养光之后，随机挑选有约 96%
            //      会被 ValidatePet 拒掉
            //
            // 结果是一个**自限循环**：领养链路修好 → 目录被领养光 → 校验开始拒绝
            // → 领养全停。实测形态：90 分钟里 completeadoption 5493 次，而
            // transaction_created_successfully **0 次**，且 create_transaction_failed
            // 也是 0 次（因为根本没走到那一步）。
            //
            // ⚠️ 这个故障全程 HTTP 200、零异常、页面正常渲染 —— 和 2026-09-26
            //    那次「假成功」是同一个观测盲区。它是被新建的业务结果比率告警
            //    在第一次运行时抓到的，不是被人看出来的。
            //
            // 默认 8 而不是"保留原行为"：原行为已被证明会让领养停摆，
            // 保留它不是稳妥而是继续坏着。要恢复旧行为，把这个变量设成一个
            // 大于宠物总数的值即可。
            var maxPerCycle = 8;
            if (Int32.TryParse(_maxAdoptionsPerCycle, out int configured) && configured > 0)
            {
                maxPerCycle = configured;
            }
            var loadSize = Math.Min(picked, maxPerCycle);
            _logger.LogInformation(
                $"Adoption load size: {loadSize} (picked {picked}, cap {maxPerCycle})");

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