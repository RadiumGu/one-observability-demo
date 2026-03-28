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

    private Pet mapToPet(Map<String, AttributeValue> item) {
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
            List<Pet> result = ddbClient.scan(buildScanRequest(petType, petColor, petId))
                    .items().stream().map(this::mapToPet)
                    .collect(Collectors.toList());
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
