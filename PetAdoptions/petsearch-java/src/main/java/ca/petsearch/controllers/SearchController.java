package ca.petsearch.controllers;

import ca.petsearch.MetricEmitter;
import ca.petsearch.RandomNumberGenerator;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Scope;
import io.opentelemetry.instrumentation.annotations.WithSpan;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.dynamodb.model.AttributeValue;
import software.amazon.awssdk.services.dynamodb.model.ComparisonOperator;
import software.amazon.awssdk.services.dynamodb.model.Condition;
import software.amazon.awssdk.services.dynamodb.model.ScanRequest;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import software.amazon.awssdk.services.s3.model.GetObjectRequest;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.s3.presigner.model.GetObjectPresignRequest;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.ssm.SsmClient;
import software.amazon.awssdk.services.ssm.model.GetParameterRequest;

import java.time.Duration;
import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

@RestController
public class SearchController {
    public static final String BUCKET_NAME = "/petstore/s3bucketname";
    public static final String DYNAMODB_TABLENAME = "/petstore/dynamodbtablename";
    private final RandomNumberGenerator randomGenerator;

    private Logger logger = LoggerFactory.getLogger(SearchController.class);

    private final S3Client s3Client;
    private final S3Presigner s3Presigner;
    private final DynamoDbClient ddbClient;
    private final SsmClient ssmClient;
    private final MetricEmitter metricEmitter;
    private final Tracer tracer;
    private Map<String, String> paramCache = new HashMap<>();

    public SearchController(S3Client s3Client, S3Presigner s3Presigner, DynamoDbClient ddbClient,
                            SsmClient ssmClient, MetricEmitter metricEmitter, Tracer tracer,
                            RandomNumberGenerator randomGenerator) {
        this.s3Client = s3Client;
        this.s3Presigner = s3Presigner;
        this.ddbClient = ddbClient;
        this.ssmClient = ssmClient;
        this.metricEmitter = metricEmitter;
        this.tracer = tracer;
        this.randomGenerator = randomGenerator;
    }

    private String getKey(String petType, String petId) {
        String folderName;
        switch (petType) {
            case "bunny": folderName = "bunnies"; break;
            case "puppy": folderName = "puppies"; break;
            default:      folderName = "kitten";  break;
        }
        return String.format("%s/%s.jpg", folderName, petId);
    }

    private String getPetUrl(String petType, String image) {
        Span span = tracer.spanBuilder("Get Pet URL").startSpan();
        try (Scope scope = span.makeCurrent()) {
            String s3BucketName = getSSMParameter(BUCKET_NAME);
            String key = getKey(petType, image);

            double randomnumber = Math.random() * 9999;
            if (randomnumber < 100) {
                logger.debug("Forced exception to show S3 bucket creation error.");
                logger.info("Trying to create a S3 Bucket");
                s3Client.createBucket(CreateBucketRequest.builder().bucket(s3BucketName).build());
            }

            logger.info("Generating presigned url");
            return s3Presigner.presignGetObject(GetObjectPresignRequest.builder()
                    .signatureDuration(Duration.ofMinutes(5))
                    .getObjectRequest(GetObjectRequest.builder()
                            .bucket(s3BucketName)
                            .key(key)
                            .build())
                    .build())
                    .url().toString();
        } catch (Exception e) {
            logger.error("Error while accessing S3 bucket", e);
            span.recordException(e);
            return "";
        } finally {
            span.end();
        }
    }

    @WithSpan("Get parameter from Systems Manager or cache")
    private String getSSMParameter(String paramName) {
        if (!paramCache.containsKey(paramName)) {
            String value = ssmClient.getParameter(
                    GetParameterRequest.builder().name(paramName).withDecryption(false).build()
            ).parameter().value();
            paramCache.put(paramName, value);
        }
        return paramCache.get(paramName);
    }

    /** DynamoDB 条目里必须齐备的属性 —— 缺任一个这条记录就无法构成一只可展示的宠物。 */
    private static final List<String> REQUIRED_PET_ATTRIBUTES = Arrays.asList(
            "petid", "availability", "cuteness_rate", "petcolor", "pettype", "price", "image");

    /**
     * 把 DynamoDB 条目映射成 Pet；**条目残缺时返回 null，由调用方过滤掉**。
     *
     * ## 为什么要容错（2026-09-26 的整站故障）
     *
     * 原实现对七个属性全部无条件解引用（{@code item.get("cuteness_rate").s()}），
     * 于是**任何一条缺字段的记录都会让整个 /api/search 返回 500** ——
     * NullPointerException 穿出 stream、穿出 try，被 {@code throw e} 重新抛出，
     * 26 条正常记录一起丢掉，petsite 首页变成 HTTP 200 + 空白错误页 20 分钟。
     *
     * 触发它只需要一次匿名 HTTP 请求：有人经 petstatusupdater（该接口无认证）
     * 往目录表写了一条只有 petid / pettype / availability 三个字段的探针记录。
     * 同一故障模式 2026-09-15 也出现过两轮，所以不是一次性意外。
     *
     * ## 为什么是跳过而不是补默认值
     *
     * 缺 price / image 的记录不是「显示不全的宠物」，而是**不该存在的记录** ——
     * 补默认值会把脏数据渲染成一只价格为 0、没有图片的宠物，
     * 让上游的数据问题永久隐身。跳过 + 计数 + 告警才能让它被修掉。
     *
     * ## 跳过必须可观测
     *
     * 静默跳过只是把「整站 500」换成「目录莫名少几只」，后者更难查。
     * 所以这里 WARN 日志带上主键与缺失字段名，并由调用方发
     * {@code petsSkippedMalformed} 计数器 —— 该指标 &gt; 0 即可直接告警。
     */
    private Pet mapToPet(Map<String, AttributeValue> item) {
        List<String> missing = REQUIRED_PET_ATTRIBUTES.stream()
                .filter(attr -> item.get(attr) == null || item.get(attr).s() == null)
                .collect(Collectors.toList());

        if (!missing.isEmpty()) {
            // 主键单独取，因为它本身也可能缺 —— 日志里必须能定位到是哪条记录。
            String keyPetType = item.get("pettype") != null ? item.get("pettype").s() : "<missing>";
            String keyPetId = item.get("petid") != null ? item.get("petid").s() : "<missing>";
            logger.warn("Skipping malformed DynamoDB item: pettype={} petid={} missingAttributes={}",
                    keyPetType, keyPetId, missing);
            Span.current().setAttribute("search.skipped_malformed_petid", keyPetId);
            return null;
        }

        String petId       = item.get("petid").s();
        String availability = item.get("availability").s();
        String cutenessRate = item.get("cuteness_rate").s();
        String petColor    = item.get("petcolor").s();
        String petType     = item.get("pettype").s();
        String price       = item.get("price").s();
        String petUrl      = getPetUrl(petType, item.get("image").s());
        return new Pet(petId, availability, cutenessRate, petColor, petType, price, petUrl);
    }

    @GetMapping("/api/search")
    public List<Pet> search(
            @RequestParam(name = "pettype",  defaultValue = "", required = false) String petType,
            @RequestParam(name = "petcolor", defaultValue = "", required = false) String petColor,
            @RequestParam(name = "petid",    defaultValue = "", required = false) String petId
    ) throws InterruptedException {
        Span span = tracer.spanBuilder("Scanning DynamoDB Table").startSpan();

        if (petType != null && !petType.trim().isEmpty() && petType.equals("bunny")) {
            logger.debug("Delaying the response on purpose, to show on traces as an issue");
            TimeUnit.MILLISECONDS.sleep(3000);
        }

        try (Scope scope = span.makeCurrent()) {
            List<Map<String, AttributeValue>> items =
                    ddbClient.scan(buildScanRequest(petType, petColor, petId)).items();

            // mapToPet 对残缺条目返回 null —— 在这里滤掉，**一条脏记录不该让整次查询失败**。
            List<Pet> result = items.stream()
                    .map(this::mapToPet)
                    .filter(Objects::nonNull)
                    .collect(Collectors.toList());

            int skipped = items.size() - result.size();
            if (skipped > 0) {
                // 既打 span 属性也发指标：span 用于单次排查，指标用于告警。
                span.setAttribute("search.skipped_malformed_count", skipped);
                metricEmitter.emitPetsSkippedMalformedMetric(skipped);
            }

            metricEmitter.emitPetsReturnedMetric(result.size());
            return result;
        } catch (Exception e) {
            span.recordException(e);
            logger.error("Error while searching, building the resulting body", e);
            throw e;
        } finally {
            span.end();
        }
    }

    private ScanRequest buildScanRequest(String petType, String petColor, String petId) {
        Map<String, Condition> filters = new HashMap<>();
        addFilter(filters, "pettype",  petType);
        addFilter(filters, "petcolor", petColor);
        addFilter(filters, "petid",    petId);

        ScanRequest.Builder builder = ScanRequest.builder().tableName(getSSMParameter(DYNAMODB_TABLENAME));
        if (!filters.isEmpty()) builder.scanFilter(filters);
        return builder.build();
    }

    private void addFilter(Map<String, Condition> filters, String key, String value) {
        if (value != null && !value.isEmpty()) {
            Span.current().setAttribute(key, value);
            filters.put(key, Condition.builder()
                    .comparisonOperator(ComparisonOperator.EQ)
                    .attributeValueList(AttributeValue.builder().s(value).build())
                    .build());
        }
    }
}
