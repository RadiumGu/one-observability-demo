/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/
package ca.petsearch;

import io.opentelemetry.api.OpenTelemetry;
import io.opentelemetry.api.common.AttributeKey;
import io.opentelemetry.api.common.Attributes;
import io.opentelemetry.api.metrics.LongCounter;
import io.opentelemetry.api.metrics.LongHistogram;
import io.opentelemetry.api.metrics.Meter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class MetricEmitter {

    private Logger logger = LoggerFactory.getLogger(MetricEmitter.class);

    static final String DIMENSION_API_NAME = "apiName";
    static final String DIMENSION_STATUS_CODE = "statusCode";

    static String API_COUNTER_METRIC = "apiBytesSent";
    static String API_LATENCY_METRIC = "latency";
    static String PETS_RETURNED_METRIC = "petsReturned";
    static String PETS_SKIPPED_METRIC = "petsSkippedMalformed";

    private LongCounter apiBytesSentCounter;
    private LongHistogram apiLatencyHistogram;
    private LongCounter petsReturned;
    private LongCounter petsSkippedMalformed;

    public MetricEmitter(OpenTelemetry otel) {
        Meter meter = otel.meterBuilder("aws-otel").setInstrumentationVersion("1.0").build();

        logger.debug("OTLP port is: " + System.getenv("OTEL_EXPORTER_OTLP_ENDPOINT"));

        String latencyMetricName = API_LATENCY_METRIC;
        String apiBytesSentMetricName = API_COUNTER_METRIC;
        String petsReturnedMetricName = PETS_RETURNED_METRIC;
        String petsSkippedMetricName = PETS_SKIPPED_METRIC;

        String instanceId = System.getenv("INSTANCE_ID");
        if (instanceId != null && !instanceId.trim().equals("")) {
            latencyMetricName = API_LATENCY_METRIC + "_" + instanceId;
            apiBytesSentMetricName = API_COUNTER_METRIC + "_" + instanceId;
            petsReturnedMetricName = PETS_RETURNED_METRIC + "_" + instanceId;
            petsSkippedMetricName = PETS_SKIPPED_METRIC + "_" + instanceId;
        }

        apiBytesSentCounter =
                meter
                        .counterBuilder(apiBytesSentMetricName)
                        .setDescription("API request load sent in bytes")
                        .setUnit("one")
                        .build();

        petsReturned =
                meter
                        .counterBuilder(petsReturnedMetricName)
                        .setDescription("Number of pets returned by this service")
                        .setUnit("one")
                        .build();

        // 被跳过的残缺记录数。**跳过必须可观测** —— 静默丢记录只是把
        // 「整站 500」换成了「目录少几只而无人知道」，那是更难查的缺陷。
        petsSkippedMalformed =
                meter
                        .counterBuilder(petsSkippedMetricName)
                        .setDescription("DynamoDB items skipped because required attributes were missing")
                        .setUnit("one")
                        .build();


        apiLatencyHistogram =
                meter
                        .histogramBuilder(latencyMetricName).ofLongs()
                        .setDescription("API latency time")
                        .setUnit("ms")
                        .build();
    }

    /**
     * emit http request latency metrics with summary metric type
     *
     * @param returnTime
     * @param apiName
     * @param statusCode
     */
    public void emitReturnTimeMetric(Long returnTime, String apiName, String statusCode) {
        logger.debug(
                "emit metric with return time " + returnTime + "ms, " + apiName + ", status code:" + statusCode);
        apiLatencyHistogram.record(
                returnTime, Attributes.of(AttributeKey.stringKey(DIMENSION_API_NAME), apiName, AttributeKey.stringKey(DIMENSION_STATUS_CODE), statusCode));
    }

    /**
     * emit http request load size with counter metrics type
     *
     * @param bytes
     * @param apiName
     * @param statusCode
     */
    public void emitBytesSentMetric(int bytes, String apiName, String statusCode) {
        logger.debug("emit metric with http request size " + bytes + " bytes, " + apiName);
        apiBytesSentCounter.add(
                bytes, Attributes.of(AttributeKey.stringKey(DIMENSION_API_NAME), apiName, AttributeKey.stringKey(DIMENSION_STATUS_CODE), statusCode));
    }

    public void emitPetsReturnedMetric(int petsCount) {
        petsReturned.add(petsCount);
    }

    /**
     * 本次查询跳过的残缺记录数。
     *
     * 为什么单独一个指标而不是只打日志：残缺记录一旦出现，日志里会被正常流量淹没，
     * 而这个计数器可以直接做告警 —— 它 &gt; 0 就意味着有人往目录表写了脏数据。
     * 2026-09-26 的整站首页故障（一条缺 4 个字段的记录让 /api/search 全量 500）
     * 当时所有常规信号都是绿的：Pod Running、目标组 healthy、ALB 5xx 无数据。
     */
    public void emitPetsSkippedMalformedMetric(int skippedCount) {
        if (skippedCount > 0) {
            petsSkippedMalformed.add(skippedCount);
        }
    }

}
