/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/
package ca.petsearch.controllers;

import ca.petsearch.MetricEmitter;
import ca.petsearch.RandomNumberGenerator;
import com.amazonaws.HttpMethod;
import com.amazonaws.services.dynamodbv2.AmazonDynamoDB;
import com.amazonaws.services.dynamodbv2.model.AttributeValue;
import com.amazonaws.services.dynamodbv2.model.ComparisonOperator;
import com.amazonaws.services.dynamodbv2.model.Condition;
import com.amazonaws.services.dynamodbv2.model.ScanRequest;
import com.amazonaws.services.s3.AmazonS3;
import com.amazonaws.services.s3.model.GeneratePresignedUrlRequest;
import com.amazonaws.services.simplesystemsmanagement.AWSSimpleSystemsManagement;
import com.amazonaws.services.simplesystemsmanagement.model.GetParameterRequest;
import com.amazonaws.services.simplesystemsmanagement.model.GetParameterResult;
import com.amazonaws.services.simplesystemsmanagement.model.ParameterNotFoundException;
import io.opentelemetry.api.trace.Span;
import io.opentelemetry.api.trace.Tracer;
import io.opentelemetry.context.Scope;
import io.opentelemetry.instrumentation.annotations.WithSpan;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.*;
import java.util.concurrent.TimeUnit;
import java.util.stream.Collectors;

@RestController
public class SearchController {
    private final RandomNumberGenerator randomGenerator;

    // Configurable parameter names via environment variables
    private final String imagesCdnUrlParam;
    private final String s3BucketParam;
    private final String dynamodbTableParam;

    private Logger logger = LoggerFactory.getLogger(SearchController.class);

    private final AmazonS3 s3Client;
    private final AmazonDynamoDB ddbClient;
    private final AWSSimpleSystemsManagement ssmClient;
    private final MetricEmitter metricEmitter;
    private final Tracer tracer;
    private Map<String, String> paramCache = new HashMap<>();

    public SearchController(AmazonS3 s3Client, AmazonDynamoDB ddbClient, AWSSimpleSystemsManagement ssmClient, MetricEmitter metricEmitter, Tracer tracer, RandomNumberGenerator randomGenerator) {
        this.s3Client = s3Client;
        this.ddbClient = ddbClient;
        this.ssmClient = ssmClient;
        this.metricEmitter = metricEmitter;
        this.tracer = tracer;
        this.randomGenerator = randomGenerator;

        // Initialize configurable parameter names from environment variables
        String paramPrefix = getRequiredEnvironmentVariable("PETSEARCH_PARAM_PREFIX");
        String imagesCdnUrlName = getRequiredEnvironmentVariable("PETSEARCH_IMAGES_CDN_URL");
        String s3BucketName = getRequiredEnvironmentVariable("PETSEARCH_S3_BUCKET_NAME");
        String dynamodbTableName = getRequiredEnvironmentVariable("PETSEARCH_DYNAMODB_TABLE_NAME");

        this.imagesCdnUrlParam = paramPrefix + "/" + imagesCdnUrlName;
        this.s3BucketParam = paramPrefix + "/" + s3BucketName;
        this.dynamodbTableParam = paramPrefix + "/" + dynamodbTableName;

        logger.info("Using SSM parameter names: ImagesCDN={}, S3Bucket={}, DynamoDBTable={}",
                   imagesCdnUrlParam, s3BucketParam, dynamodbTableParam);
    }

    /**
     * Get a required environment variable, throwing an exception if it's missing or empty
     */
    private String getRequiredEnvironmentVariable(String name) {
        String value = System.getenv(name);
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalStateException("Required environment variable '" + name + "' is not set or is empty");
        }
        return value.trim();
    }

    private String getKey(String petType, String petId) {

        String folderName;

        switch (petType) {
            case "bunny":
                folderName = "bunnies";
                break;
            case "puppy":
                folderName = "puppies";
                break;
            default:
                folderName = "kittens";
                break;
        }

        return String.format("%s/%s.jpg", folderName, petId);

    }

    private String getPetUrl(String petType, String image) {
        Span span = tracer.spanBuilder("Get Pet URL").startSpan();

        try(Scope scope = span.makeCurrent()) {
            // CloudFront now serves the images directly - no need for pre-signed URLs
            String imagesCdnUrl = getSSMParameter(imagesCdnUrlParam);
            String key = getKey(petType, image);

            String cloudFrontUrl = String.format("%s/%s", imagesCdnUrl, key);
            logger.info("Using CloudFront URL: {}", cloudFrontUrl);

            return cloudFrontUrl;

        } catch (Exception e) {
            logger.error("Error while building CloudFront URL", e);
            span.recordException(e);
            throw (e);
        } finally {
            span.end();
        }
    }

    @WithSpan("Get parameter from Systems Manager or cache") // this annotation can be used as an alternative to tracer.spanBuilder
    private String getSSMParameter(String paramName) {
        logger.info("Attempting to retrieve SSM parameter: {}", paramName);

        if (!paramCache.containsKey(paramName)) {
            try {
                logger.debug("Parameter not in cache, fetching from SSM: {}", paramName);

                GetParameterRequest parameterRequest = new GetParameterRequest().withName(paramName).withWithDecryption(false);

                GetParameterResult parameterResult = ssmClient.getParameter(parameterRequest);
                String paramValue = parameterResult.getParameter().getValue();

                logger.info("Successfully retrieved SSM parameter '{}' with value: {}", paramName,
                           paramValue != null ? paramValue.substring(0, Math.min(50, paramValue.length())) + "..." : "null");

                paramCache.put(paramName, paramValue);
                return paramValue;

            } catch (ParameterNotFoundException e) {
                logger.error("SSM Parameter NOT FOUND: '{}'. This parameter does not exist in Parameter Store.", paramName);
                logger.error("Available environment variables for debugging:");
                System.getenv().entrySet().stream()
                    .filter(entry -> entry.getKey().startsWith("PETSEARCH_"))
                    .forEach(entry -> logger.error("  {} = {}", entry.getKey(), entry.getValue()));

                // Add span attributes for better tracing
                Span currentSpan = Span.current();
                currentSpan.setAttribute("error", true);
                currentSpan.setAttribute("error.parameter_name", paramName);
                currentSpan.setAttribute("error.type", "ParameterNotFoundException");
                currentSpan.recordException(e);

                throw new RuntimeException("Failed to retrieve SSM parameter: " + paramName +
                                         ". Parameter does not exist in Parameter Store.", e);

            } catch (Exception e) {
                logger.error("Unexpected error retrieving SSM parameter '{}': {}", paramName, e.getMessage(), e);

                // Add span attributes for better tracing
                Span currentSpan = Span.current();
                currentSpan.setAttribute("error", true);
                currentSpan.setAttribute("error.parameter_name", paramName);
                currentSpan.setAttribute("error.type", e.getClass().getSimpleName());
                currentSpan.recordException(e);

                throw new RuntimeException("Failed to retrieve SSM parameter: " + paramName, e);
            }
        } else {
            logger.debug("Using cached value for SSM parameter: {}", paramName);
            return paramCache.get(paramName);
        }
    }

    /** DynamoDB 条目里必须齐备的属性 —— 缺任一个这条记录就无法构成一只可展示的宠物。 */
    private static final List<String> REQUIRED_PET_ATTRIBUTES = List.of(
            "petid", "availability", "cuteness_rate", "petcolor", "pettype", "price", "image");

    /**
     * 把 DynamoDB 条目映射成 Pet；**条目残缺时返回 null，由调用方过滤掉**。
     *
     * ## 为什么要容错（2026-09-26 的整站故障）
     *
     * 原实现对七个属性全部无条件解引用：
     *
     * <pre>
     *   String cutenessRate = item.get("cuteness_rate").getS();   // item.get() 为 null -&gt; NPE
     *   String price        = item.get("price").getS();
     *   String petUrl       = getPetUrl(petType, item.get("image").getS());
     * </pre>
     *
     * 于是**任何一条缺字段的记录都会让整个 /api/search 返回 500** ——
     * 异常穿出 stream、穿出 try，被 `throw e` 重新抛出，26 条正常记录一起丢掉，
     * petsite 首页变成空白错误页。
     *
     * 实测触发过一次：有人经 petstatusupdater（**该接口无认证**）往目录表写了一条
     * 只有 petid / pettype / availability 三个字段的探针记录，
     * 首页随即不可用 20 分钟。**一条脏数据打挂整站**，而写入门槛是一次匿名 HTTP 请求。
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
     * `petsSkippedMalformed` 计数器 —— 该指标 &gt; 0 即可直接告警。
     */
    private Pet mapToPet(Map<String, AttributeValue> item) {
        List<String> missing = REQUIRED_PET_ATTRIBUTES.stream()
                .filter(attr -> item.get(attr) == null || item.get(attr).getS() == null)
                .collect(Collectors.toList());

        if (!missing.isEmpty()) {
            // 主键单独取，因为它本身也可能缺 —— 日志里必须能定位到是哪条记录。
            String keyPetType = item.get("pettype") != null ? item.get("pettype").getS() : "<missing>";
            String keyPetId = item.get("petid") != null ? item.get("petid").getS() : "<missing>";
            logger.warn("Skipping malformed DynamoDB item: pettype={} petid={} missingAttributes={}",
                    keyPetType, keyPetId, missing);
            Span.current().setAttribute("search.skipped_malformed_petid", keyPetId);
            return null;
        }

        String petId = item.get("petid").getS();
        String availability = item.get("availability").getS();
        String cutenessRate = item.get("cuteness_rate").getS();
        String petColor = item.get("petcolor").getS();
        String petType = item.get("pettype").getS();
        String price = item.get("price").getS();
        String petUrl = getPetUrl(petType, item.get("image").getS());

        Pet currentPet = new Pet(petId, availability, cutenessRate, petColor, petType, price, petUrl);
        return currentPet;
    }


    /**
     * Create SearchQuery object with parameter alias resolution
     * Similar to petfood Rust application's serde alias handling
     */
    private SearchQuery createSearchQuery(String petType, String petTypeAlias,
                                        String petColor, String petColorAlias,
                                        String petId, String petIdAlias) {
        // Resolve parameter aliases - primary names take precedence over aliases
        String resolvedPetType = !SearchQuery.isEmptyParameter(petType) ? petType : petTypeAlias;
        String resolvedPetColor = !SearchQuery.isEmptyParameter(petColor) ? petColor : petColorAlias;
        String resolvedPetId = !SearchQuery.isEmptyParameter(petId) ? petId : petIdAlias;

        return new SearchQuery(resolvedPetType, resolvedPetColor, resolvedPetId);
    }

    @GetMapping("/api/search")
    public List<Pet> search(
            @RequestParam(name = "pettype", defaultValue = "", required = false) String petType,
            @RequestParam(name = "pet_type", defaultValue = "", required = false) String petTypeAlias,
            @RequestParam(name = "petcolor", defaultValue = "", required = false) String petColor,
            @RequestParam(name = "pet_color", defaultValue = "", required = false) String petColorAlias,
            @RequestParam(name = "petid", defaultValue = "", required = false) String petId,
            @RequestParam(name = "pet_id", defaultValue = "", required = false) String petIdAlias,
            @RequestParam(name = "userId", defaultValue = "", required = false) String userId,
            @RequestParam(name = "user_id", defaultValue = "", required = false) String userIdAlias
    ) throws InterruptedException {

        // Create SearchQuery object with parameter resolution (similar to petfood Rust serde aliases)
        SearchQuery query = createSearchQuery(petType, petTypeAlias, petColor, petColorAlias, petId, petIdAlias);

        Span span = tracer.spanBuilder("Scanning DynamoDB Table").startSpan();

        // Use validated parameters from SearchQuery
        String validatedPetType = query.getValidatedPetType();
        String normalizedPetColor = query.getNormalizedPetColor();
        String normalizedPetId = query.getNormalizedPetId();

        // This line is intentional. Delays searches
        if (!SearchQuery.isEmptyParameter(validatedPetType) && validatedPetType.equals("bunny")) {
            logger.debug("Delaying the response on purpose, to show on traces as an issue");
            TimeUnit.MILLISECONDS.sleep(3000);
        }

        try(Scope scope = span.makeCurrent()) {
            // Log the resolved parameters for tracing
            span.setAttribute("search.pettype", validatedPetType);
            span.setAttribute("search.petcolor", normalizedPetColor);
            span.setAttribute("search.petid", normalizedPetId);
            span.setAttribute("search.userid", userId);
            span.setAttribute("search.userid_alias", userIdAlias);

            List<Map<String, AttributeValue>> items = ddbClient.scan(
                    buildScanRequest(validatedPetType, normalizedPetColor, normalizedPetId))
                    .getItems();

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
        return Map.of("pettype", petType,
                "petcolor", petColor,
                "petid", petId).entrySet().stream()
                .filter(e -> !isEmptyParameter(e))
                .map(this::entryToCondition)
                .reduce(emptyScanRequest(), this::addScanFilter, this::joinScanResult);
    }

    private ScanRequest addScanFilter(ScanRequest scanResult, Map.Entry<String, Condition> element) {
        return scanResult.addScanFilterEntry(element.getKey(), element.getValue());
    }

    private ScanRequest emptyScanRequest() {
        return new ScanRequest().withTableName(getSSMParameter(dynamodbTableParam));
    }

    private ScanRequest joinScanResult(ScanRequest scanRequest1, ScanRequest scanRequest2) {
        Map<String, Condition> merged = new HashMap<>();
        merged.putAll(scanRequest1.getScanFilter() != null ? scanRequest1.getScanFilter() : Collections.emptyMap());
        merged.putAll(scanRequest2.getScanFilter() != null ? scanRequest2.getScanFilter() : Collections.emptyMap());

        return scanRequest1.withScanFilter(merged);
    }

    private Map.Entry<String, Condition> entryToCondition(Map.Entry<String, String> e) {
        Span.current().setAttribute(e.getKey(), e.getValue());
        return Map.entry(e.getKey(), new Condition()
                .withComparisonOperator(ComparisonOperator.EQ)
                .withAttributeValueList(new AttributeValue().withS(e.getValue())));
    }

    private boolean isEmptyParameter(Map.Entry<String, String> e) {
        return e.getValue() == null || e.getValue().isEmpty();
    }

}
