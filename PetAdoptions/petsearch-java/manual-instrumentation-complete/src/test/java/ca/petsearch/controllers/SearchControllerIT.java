/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/
package ca.petsearch.controllers;

import com.amazonaws.services.dynamodbv2.AmazonDynamoDB;
import com.amazonaws.services.dynamodbv2.AmazonDynamoDBClientBuilder;
import com.amazonaws.services.dynamodbv2.model.AttributeValue;
import com.amazonaws.services.dynamodbv2.model.DeleteItemRequest;
import com.amazonaws.services.dynamodbv2.model.PutItemRequest;
import com.amazonaws.services.s3.AmazonS3;
import com.amazonaws.services.s3.AmazonS3ClientBuilder;
import com.amazonaws.services.simplesystemsmanagement.AWSSimpleSystemsManagement;
import com.amazonaws.services.simplesystemsmanagement.AWSSimpleSystemsManagementClientBuilder;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.web.server.LocalServerPort;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.context.annotation.Profile;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.context.TestPropertySource;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.*;

@Testcontainers
@ActiveProfiles("test")
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@Tag("integration")
@TestPropertySource(properties = {"AWS_REGION=us-east-2"})
public class SearchControllerIT {

    private static final String BUCKET_NAME = "petsearch";
    public static final String DYNAMODB_TABLE = "petsearch";

    @LocalServerPort
    private int port;

    @Autowired
    private TestRestTemplate restTemplate;

    @Autowired
    private AmazonDynamoDB dynamoDbClient;

    private String kittenId;

    private String puppyId;

    private String bunnyId;

    @Container
    public static LocalStackContainer localStack = new LocalStackContainer("0.10.0")
            .withServices(S3, DYNAMODB, SSM)
            .withEnv("DEFAULT_REGION", "us-east-2");

    @BeforeAll
    static void beforeAll() throws IOException, InterruptedException {
        localStack.execInContainer("awslocal", "ssm", "put-parameter", "--name", "/petstore/s3bucketname", "--type", "String", "--value", BUCKET_NAME);
        localStack.execInContainer("awslocal", "ssm", "put-parameter", "--name", "/petstore/dynamodbtablename", "--type", "String", "--value", DYNAMODB_TABLE);
        localStack.execInContainer("awslocal", "dynamodb", "create-table", "--table-name", DYNAMODB_TABLE,
                "--key-schema", "AttributeName=petid,KeyType=HASH",
                "--attribute-definitions", "AttributeName=petid,AttributeType=S AttributeName=availability,AttributeType=S",
                "--provisioned-throughput", "ReadCapacityUnits=5,WriteCapacityUnits=5");

        localStack.execInContainer("awslocal", "s3", "mb", "s3://" + BUCKET_NAME);
    }

    @BeforeEach
    public void addPets() {
        if (kittenId == null) {
            kittenId = putPet(new HashMap<>(Map.of(
                    "pettype", new AttributeValue().withS("kitten"),
                    "petcolor", new AttributeValue().withS("braun"),
                    "availability", new AttributeValue().withS("now"),
                    "cuteness_rate", new AttributeValue().withS("high"),
                    "price", new AttributeValue().withS("500.00")
            )));
        }
        if (bunnyId == null) {
            bunnyId = putPet(new HashMap<>(Map.of(
                    "pettype", new AttributeValue().withS("bunny"),
                    "petcolor", new AttributeValue().withS("black"),
                    "availability", new AttributeValue().withS("now"),
                    "cuteness_rate", new AttributeValue().withS("high"),
                    "price", new AttributeValue().withS("150.00")
            )));
        }
        if (puppyId == null) {
            puppyId = putPet(new HashMap<>(Map.of(
                    "pettype", new AttributeValue().withS("puppy"),
                    "petcolor", new AttributeValue().withS("white"),
                    "availability", new AttributeValue().withS("now"),
                    "cuteness_rate", new AttributeValue().withS("high"),
                    "price", new AttributeValue().withS("350.00")
            )));
        }
    }

    private String putPet(Map<String, AttributeValue> petData) {
        final String id = UUID.randomUUID().toString();
        petData.put("petid", new AttributeValue().withS(id));
        petData.put("image", new AttributeValue().withS(id));
        final PutItemRequest putItemRequest = new PutItemRequest()
                .withTableName(DYNAMODB_TABLE)
                .withItem(
                        petData
                );
        dynamoDbClient.putItem(putItemRequest);
        return id;
    }


    @Test
    public void testSearchNoFilters() {
        assertThat(this.restTemplate.getForObject("http://localhost:" + port + "/api/search",
                String.class))
                .contains("petid", "availability", "petcolor", "peturl", kittenId, bunnyId, puppyId)
                .doesNotContain("{S:")
        ;
    }

    /**
     * 一条残缺记录不得让整次查询失败 —— 它必须被跳过，其余宠物照常返回。
     *
     * ## 为什么有这条测试
     *
     * 2026-09-26 生产事故：有人经 petstatusupdater（该接口**无认证**）往宠物目录表
     * 写了一条只有 petid / pettype / availability 三个字段的探针记录。
     * 当时的 `mapToPet` 对七个属性全部无条件 `.getS()`，于是抛 NullPointerException，
     * 异常穿出 stream 被重新抛出，**整个 /api/search 返回 500**，
     * 26 条正常记录一起丢掉，petsite 首页变成空白错误页，持续 20 分钟。
     *
     * 当时所有常规信号都是绿的：Pod `2/2 Running`、ALB 目标组 `healthy`、
     * ALB 5xx 无数据（petsite 把后端错误包成 HTTP 200 错误页）。
     * 只有业务探针发现了它 —— 所以这条断言要钉住的是
     * **「坏数据的影响范围必须限制在它自己这一条上」**。
     */
    @Test
    public void testMalformedItemIsSkippedAndDoesNotFailTheSearch() {
        // 只带主键与 availability，缺 cuteness_rate / petcolor / price / image ——
        // 复刻那条探针记录的形状。注意不能走 putPet()：它会补上 petid 与 image。
        final String malformedId = "MALFORMED-" + UUID.randomUUID();
        dynamoDbClient.putItem(new PutItemRequest()
                .withTableName(DYNAMODB_TABLE)
                .withItem(new HashMap<>(Map.of(
                        "pettype", new AttributeValue().withS("puppy"),
                        "petid", new AttributeValue().withS(malformedId),
                        "availability", new AttributeValue().withS("no")
                ))));

        try {
            String body = this.restTemplate.getForObject(
                    "http://localhost:" + port + "/api/search", String.class);

            // 1) 整次查询必须成功，且三只正常宠物一只都不能少。
            //    修复前这里拿到的是 500 错误体，三个 id 全都不在。
            assertThat(body)
                    .contains("petid", "availability", "petcolor", "peturl",
                            kittenId, bunnyId, puppyId);

            // 2) 残缺记录本身必须被跳过 —— 不是补默认值渲染成一只 0 元无图的宠物。
            assertThat(body).doesNotContain(malformedId);
        } finally {
            dynamoDbClient.deleteItem(new DeleteItemRequest()
                    .withTableName(DYNAMODB_TABLE)
                    .withKey(Map.of(
                            "pettype", new AttributeValue().withS("puppy"),
                            "petid", new AttributeValue().withS(malformedId)
                    )));
        }
    }

    @Test
    public void testSearchByPetType() {
        assertThat(this.restTemplate.getForObject("http://localhost:" + port + "/api/search?pettype=bunny",
                String.class))
                .contains("petid", "availability", "petcolor", "peturl", bunnyId)
                .doesNotContain(kittenId, puppyId);

        assertThat(this.restTemplate.getForObject("http://localhost:" + port + "/api/search?pettype=puppy",
                String.class))
                .contains("petid", "availability", "petcolor", "peturl", puppyId)
                .doesNotContain(kittenId, bunnyId);

        assertThat(this.restTemplate.getForObject("http://localhost:" + port + "/api/search?pettype=kitten",
                String.class))
                .contains("petid", "availability", "petcolor", "peturl", kittenId)
                .doesNotContain(puppyId, bunnyId);
    }

    @Test
    public void testSearchByPetColor() {
        assertThat(this.restTemplate.getForObject("http://localhost:" + port + "/api/search?petcolor=braun",
                String.class))
                .contains("petid", "availability", "petcolor", "peturl", kittenId)
                .doesNotContain(bunnyId, puppyId);

        assertThat(this.restTemplate.getForObject("http://localhost:" + port + "/api/search?petcolor=black",
                String.class))
                .contains("petid", "availability", "petcolor", "peturl", bunnyId)
                .doesNotContain(kittenId, puppyId);

        assertThat(this.restTemplate.getForObject("http://localhost:" + port + "/api/search?petcolor=white",
                String.class))
                .contains("petid", "availability", "petcolor", "peturl", puppyId)
                .doesNotContain(kittenId, bunnyId);
    }

    @Test
    public void testSearchByPetId() {
        assertThat(this.restTemplate.getForObject("http://localhost:" + port + "/api/search?petid=" + kittenId,
                String.class))
                .contains("petid", "availability", "petcolor", "peturl", kittenId)
                .doesNotContain(bunnyId, puppyId);

        assertThat(this.restTemplate.getForObject("http://localhost:" + port + "/api/search?petid=" + bunnyId,
                String.class))
                .contains("petid", "availability", "petcolor", "peturl", bunnyId)
                .doesNotContain(kittenId, puppyId);

        assertThat(this.restTemplate.getForObject("http://localhost:" + port + "/api/search?petid=" + puppyId,
                String.class))
                .contains("petid", "availability", "petcolor", "peturl", puppyId)
                .doesNotContain(kittenId, bunnyId);
    }

    @TestConfiguration
    static class AWSTestConfig {

        @Bean
        @Primary
        public AmazonS3 amazonS3() {
            return AmazonS3ClientBuilder.standard()
                    .withCredentials(localStack.getDefaultCredentialsProvider())
                    .withEndpointConfiguration(localStack.getEndpointConfiguration(S3))
                    .build();
        }

        @Bean
        @Primary
        public AmazonDynamoDB amazonDynamoDB() {
            return AmazonDynamoDBClientBuilder.standard()
                    .withCredentials(localStack.getDefaultCredentialsProvider())
                    .withEndpointConfiguration(localStack.getEndpointConfiguration(DYNAMODB))
                    .build();
        }

        @Bean
        @Primary
        public AWSSimpleSystemsManagement awsSimpleSystemsManagement() {
            return AWSSimpleSystemsManagementClientBuilder.standard()
                    .withCredentials(localStack.getDefaultCredentialsProvider())
                    .withEndpointConfiguration(localStack.getEndpointConfiguration(SSM))
                    .build();
        }

    }
}
