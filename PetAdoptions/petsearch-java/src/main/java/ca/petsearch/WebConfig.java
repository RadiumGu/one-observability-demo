package ca.petsearch;

import io.opentelemetry.api.GlobalOpenTelemetry;
import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.trace.Tracer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.servlet.FilterRegistrationBean;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.servlet.config.annotation.WebMvcConfigurer;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.dynamodb.DynamoDbClient;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.presigner.S3Presigner;
import software.amazon.awssdk.services.ssm.SsmClient;

import java.net.URI;
import java.util.Arrays;

@Configuration
public class WebConfig implements WebMvcConfigurer {

    @Value("${aws.local.endpoint:#{null}}")
    private String endpoint;

    @Value("${cloud.aws.region.static:ap-northeast-1}")
    private String region;

    @Bean
    public RandomNumberGenerator randomNumberGenerator() {
        return new PseudoRandomNumberGenerator();
    }

    @Bean
    public OpenTelemetry openTelemetry() {
        return GlobalOpenTelemetry.get();
    }

    @Bean
    public Tracer tracer(OpenTelemetry otel) {
        return otel.getTracer("petsearch");
    }

    @Bean
    public S3Client s3Client() {
        var builder = S3Client.builder().region(Region.of(region));
        if (endpoint != null && !endpoint.isEmpty()) builder.endpointOverride(URI.create(endpoint));
        return builder.build();
    }

    @Bean
    public S3Presigner s3Presigner() {
        var builder = S3Presigner.builder().region(Region.of(region));
        if (endpoint != null && !endpoint.isEmpty()) builder.endpointOverride(URI.create(endpoint));
        return builder.build();
    }

    @Bean
    public DynamoDbClient dynamoDbClient() {
        var builder = DynamoDbClient.builder().region(Region.of(region));
        if (endpoint != null && !endpoint.isEmpty()) builder.endpointOverride(URI.create(endpoint));
        return builder.build();
    }

    @Bean
    public SsmClient ssmClient() {
        var builder = SsmClient.builder().region(Region.of(region));
        if (endpoint != null && !endpoint.isEmpty()) builder.endpointOverride(URI.create(endpoint));
        return builder.build();
    }

    @Bean
    public MetricEmitter metricEmitter(OpenTelemetry otel) {
        return new MetricEmitter(otel);
    }

    @Bean
    public FilterRegistrationBean<ApplicationFilter> filterRegistrationBean(MetricEmitter metricEmitter) {
        FilterRegistrationBean<ApplicationFilter> filterBean = new FilterRegistrationBean<>();
        filterBean.setFilter(new ApplicationFilter(metricEmitter));
        filterBean.setUrlPatterns(Arrays.asList("/api/search"));
        return filterBean;
    }
}
