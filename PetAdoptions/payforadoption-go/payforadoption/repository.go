/*
Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
SPDX-License-Identifier: Apache-2.0
*/
package payforadoption

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/sqs"
	"github.com/aws/aws-sdk-go-v2/service/sqs/types"
	"github.com/aws/aws-sdk-go-v2/service/ssm"
	"github.com/dghubble/sling"
	"github.com/go-kit/log"
	"github.com/guregu/dynamo/v2"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel/trace"
)

// PetIdentifier represents a unique pet that was successfully reset
type PetIdentifier struct {
	PetID   string
	PetType string
	// TxnIDs 是本次重置**实际观察到**的那些交易行的主键。
	//
	// 为什么需要它：原来 DropTransactionsByPets 按 (pet_id, pet_type) 删，
	// 会把「读列表之后才产生」的新交易行一起删掉，于是宠物变成
	// availability='no' 且无交易行 —— 而重置的列表来自 transactions，
	// 所以那只宠物**永远回不来**。2026-10-03 实测 20 小时内 26 只里
	// 有 17 只就是这样消失的，领养成功率从 80% 单调掉到 33%。
	//
	// 只删观察到的行，第 3 步新产生的那条就会留下，下一轮重置能看到它。
	TxnIDs []int64
}

// Repository as an interface to define data store interactions
type Repository interface {
	CreateTransaction(ctx context.Context, a Adoption) error
	SendHistoryMessage(ctx context.Context, a Adoption) error
	DropTransactions(ctx context.Context) error
	DropTransactionsByPets(ctx context.Context, pets []PetIdentifier) error
	UpdateAvailability(ctx context.Context, a Adoption) error
	ResetPetsAvailability(ctx context.Context) ([]PetIdentifier, error)
	ValidatePet(ctx context.Context, a Adoption) error
	TriggerSeeding(ctx context.Context) error
	CreateSQLTables(ctx context.Context) error
	ErrorModeOn(ctx context.Context) bool
	GetConnectionString(ctx context.Context) (string, error)
}

type Config struct {
	UpdateAdoptionURL    string
	PetSearchURL         string
	RDSSecretArn         string
	S3BucketName         string
	DynamoDBTable        string
	SQSQueueURL          string
	AWSRegion            string
	Tracer               trace.Tracer
	AWSCfg               aws.Config
	DDBInterfaceEndpoint string
	S3InterfaceEndpoint  string
}

var RepoErr = errors.New("unable to handle Repo Request")

// repo as an implementation of Repository with dependency injection
type repo struct {
	db     *sql.DB
	cfg    Config
	logger log.Logger
	dbSvc  *DatabaseConfigService
}

func NewRepository(db *sql.DB, cfg Config, logger log.Logger) Repository {
	return &repo{
		db:     db,
		cfg:    cfg,
		logger: log.With(logger, "repo", "sql"),
		dbSvc:  NewDatabaseConfigService(cfg),
	}
}

func (r *repo) CreateTransaction(ctx context.Context, a Adoption) error {
	span := trace.SpanFromContext(ctx)
	span.AddEvent("creating transaction in PG DB")

	sql := `INSERT INTO transactions (pet_id, pet_type, adoption_date, transaction_id, user_id) VALUES ($1, $2, $3, $4, $5)`

	r.logger.Log("sql", sql)
	_, err := r.db.ExecContext(ctx, sql, a.PetID, a.PetType, a.AdoptionDate, a.TransactionID, a.UserID)
	if err != nil {
		span.RecordError(err)
		ErrorWithTrace(ctx, r.logger, "error", "failed to create transaction", "err", err)
		return NewInternalError("failed to create transaction in database", err)
	}

	InfoWithTrace(ctx, r.logger,
		"action", "transaction_created",
		"transactionId", a.TransactionID,
		"petId", a.PetID,
		"petType", a.PetType,
		"userId", a.UserID,
	)

	return nil
}

func (r *repo) SendHistoryMessage(ctx context.Context, a Adoption) error {
	// Create SQS client
	sqsClient := sqs.NewFromConfig(r.cfg.AWSCfg)

	// Prepare the adoption history message
	historyMessage := map[string]interface{}{
		"transactionId": a.TransactionID,
		"petId":         a.PetID,
		"petType":       a.PetType,
		"userId":        a.UserID,
		"adoptionDate":  a.AdoptionDate.Format(time.RFC3339),
		"timestamp":     time.Now().Format(time.RFC3339),
	}

	// Convert to JSON
	messageBody, err := json.Marshal(historyMessage)
	if err != nil {
		ErrorWithTrace(ctx, r.logger, "error", "failed to marshal history message", "err", err)
		return NewInternalError("failed to marshal history message", err)
	}

	// Send message to SQS
	input := &sqs.SendMessageInput{
		QueueUrl:    aws.String(r.cfg.SQSQueueURL),
		MessageBody: aws.String(string(messageBody)),
		MessageAttributes: map[string]types.MessageAttributeValue{
			"PetType": {
				DataType:    aws.String("String"),
				StringValue: aws.String(a.PetType),
			},
			"UserID": {
				DataType:    aws.String("String"),
				StringValue: aws.String(a.UserID),
			},
			"TransactionID": {
				DataType:    aws.String("String"),
				StringValue: aws.String(a.TransactionID),
			},
		},
	}

	result, err := sqsClient.SendMessage(ctx, input)
	if err != nil {
		ErrorWithTrace(ctx, r.logger, "error", "failed to send history message to SQS", "err", err, "queueUrl", r.cfg.SQSQueueURL)
		return NewServiceUnavailableError("failed to send history message to SQS", err)
	}

	InfoWithTrace(ctx, r.logger,
		"action", "history_message_sent",
		"messageId", aws.ToString(result.MessageId),
		"queueUrl", r.cfg.SQSQueueURL,
		"transactionId", a.TransactionID,
		"petId", a.PetID,
		"userId", a.UserID,
	)

	return nil
}

func (r *repo) DropTransactions(ctx context.Context) error {
	span := trace.SpanFromContext(ctx)
	span.AddEvent("removing all transactions in PG DB")

	sql := `DELETE FROM transactions`

	result, err := r.db.ExecContext(ctx, sql)
	if err != nil {
		span.RecordError(err)
		ErrorWithTrace(ctx, r.logger, "error", "failed to delete all transactions", "err", err)
		return NewInternalError("failed to delete transactions from database", err)
	}

	rowsAffected, _ := result.RowsAffected()
	InfoWithTrace(ctx, r.logger,
		"action", "user_transactions_deleted",
		"sql", sql,
		"rowsAffected", rowsAffected,
	)

	return nil
}

// DropTransactionsByPets deletes transactions only for the specified pets
// This ensures we only delete transactions for pets that were successfully reset
func (r *repo) DropTransactionsByPets(ctx context.Context, pets []PetIdentifier) error {
	logger := log.With(r.logger, "method", "DropTransactionsByPets")
	span := trace.SpanFromContext(ctx)
	span.AddEvent("removing transactions for specific pets")

	if len(pets) == 0 {
		InfoWithTrace(ctx, logger, "action", "no_transactions_to_delete", "count", 0)
		return nil
	}

	// 按**本轮实际观察到的行主键**删，而不是按 (pet_id, pet_type) 删。
	//
	// 原来的写法是 DELETE ... WHERE (pet_id=$1 AND pet_type=$2) OR ...
	// 它有一个 TOCTOU 竞态：
	//   1. 重置读到列表 [X]
	//   2. 把 X 复原成 yes
	//   3. ★ 生成器又领养了 X → X 变 no，产生一条**新**交易行
	//   4. 按 pet_id 删 → 把第 3 步那条新行也删了
	//   5. X 是 no 且无交易行 → 而重置列表来自 transactions → **永远回不来**
	//
	// 2026-10-03 实测：3 个生成器每 20 秒领养、cleanup 每约 16 秒一次，
	// 这个竞态持续命中，20 小时内 26 只宠物有 17 只被孤立，
	// 领养成功率从 80% 单调掉到 33%。
	//
	// 只删观察到的行，第 3 步那条就会留下，下一轮重置能看到它。
	var ids []int64
	for _, pet := range pets {
		ids = append(ids, pet.TxnIDs...)
	}

	if len(ids) == 0 {
		// 刻意不退回「按宠物删」—— 那正是上面那个竞态的来源。
		// 没有主键就什么都不删，让下一轮重置重新读到这些行。
		WarnWithTrace(ctx, logger, "warning", "no_txn_ids_to_delete",
			"message", "pets carried no observed transaction ids; deleting nothing on purpose",
			"petCount", len(pets))
		return nil
	}

	var conditions []string
	var args []interface{}
	for i, id := range ids {
		conditions = append(conditions, fmt.Sprintf("$%d", i+1))
		args = append(args, id)
	}

	// nosemgrep: go.lang.security.audit.database.string-formatted-query.string-formatted-query
	// Safe: SQL string is built from parameterized placeholders ($1, $2, etc.), not user input
	// All actual values are passed via args slice using parameterized queries
	sql := fmt.Sprintf("DELETE FROM transactions WHERE id IN (%s)", strings.Join(conditions, ", "))

	result, err := r.db.ExecContext(ctx, sql, args...)
	if err != nil {
		span.RecordError(err)
		ErrorWithTrace(ctx, logger, "error", "failed to delete pet transactions", "err", err, "petCount", len(pets))
		return NewInternalError("failed to delete pet transactions from database", err)
	}

	rowsAffected, _ := result.RowsAffected()
	InfoWithTrace(ctx, logger,
		"action", "pet_transactions_deleted",
		"petCount", len(pets),
		"txnCount", len(ids),
		"rowsAffected", rowsAffected,
	)

	return nil
}

// callPetUpdater makes an HTTP call to the pet updater service to update pet availability
// req.PetAvailability: "yes" to make pet available, "no" to mark as adopted, empty string uses default behavior
func (r *repo) callPetUpdater(ctx context.Context, req completeAdoptionRequest) error {
	logger := log.With(r.logger, "method", "callPetUpdater")
	ctx, span := r.cfg.Tracer.Start(ctx, "Update Adoption Status")
	defer span.End()

	client := http.Client{Transport: otelhttp.NewTransport(http.DefaultTransport), Timeout: 5 * time.Second}
	httpReq, _ := sling.New().Put(r.cfg.UpdateAdoptionURL).BodyJSON(&req).Request()

	resp, err := client.Do(httpReq.WithContext(ctx))
	if err != nil {
		ErrorWithTrace(ctx, logger, "err", err)
		span.RecordError(err)
		return err
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		ErrorWithTrace(ctx, logger, "err", err)
		span.RecordError(err)
		return err
	}

	LogWithTrace(ctx, logger, "response_body", string(respBody), "availability", req.PetAvailability)
	return nil
}

func (r *repo) UpdateAvailability(ctx context.Context, a Adoption) error {
	logger := log.With(r.logger, "method", "UpdateAvailability")
	ctx, parentSpan := r.cfg.Tracer.Start(ctx, "UpdateAvailability")
	defer parentSpan.End()

	errs := make(chan error)
	var wg sync.WaitGroup
	wg.Add(2)

	// Call pet updater service (empty availability = mark as adopted)
	go func() {
		defer wg.Done()
		req := completeAdoptionRequest{
			PetId:   a.PetID,
			PetType: a.PetType,
			UserID:  a.UserID,
		}
		if err := r.callPetUpdater(ctx, req); err != nil {
			errs <- err
		}
	}()

	// Dummy availability check
	go func() {
		defer wg.Done()
		availabilityCtx, availabilitySpan := r.cfg.Tracer.Start(ctx, "Invoking Availability API")
		defer availabilitySpan.End()

		client := http.Client{Transport: otelhttp.NewTransport(http.DefaultTransport), Timeout: 5 * time.Second}
		request, err := http.NewRequestWithContext(availabilityCtx, http.MethodGet, "https://amazon.com", nil)
		if err != nil {
			ErrorWithTrace(availabilityCtx, logger, "err", err)
			availabilitySpan.RecordError(err)
			errs <- err
			return
		}
		client.Do(request)
	}()

	go func() {
		wg.Wait()
		close(errs)
	}()

	// return the first error
	for err := range errs {
		if err != nil {
			return err
		}
	}

	return nil
}

func (r *repo) ValidatePet(ctx context.Context, a Adoption) error {
	// r.cfg.PetSearchURL
	logger := log.With(r.logger, "method", "ValidatePet")
	ctx, span := r.cfg.Tracer.Start(ctx, "ValidatePet")
	defer span.End()
	// using xray as a wrapper for http client
	client := http.Client{Transport: otelhttp.NewTransport(http.DefaultTransport), Timeout: 5 * time.Second}

	params := &completeAdoptionRequest{
		PetId:   a.PetID,
		PetType: a.PetType,
		UserID:  a.UserID,
	}
	req, _ := sling.New().Get(r.cfg.PetSearchURL).QueryStruct(params).Request()

	InfoWithTrace(ctx, logger, "url", req.URL.String())
	resp, err := client.Do(req.WithContext(ctx))
	if err != nil {
		ErrorWithTrace(ctx, logger, "err", err)
		span.RecordError(err)
		return NewServiceUnavailableError("pet search service unavailable", err)
	}

	if resp.StatusCode != 200 {
		span.AddEvent("Pet not available")
		span.RecordError(err)
		if resp.StatusCode == 404 {
			reason := fmt.Sprintf("Petid: %s - Pettype: %s, doesn't exist", a.PetID, a.PetType)
			LogWithTrace(ctx, logger, "status", resp.Status, "message", reason)
			return NewNotFoundError(reason, err)
		}
		err := fmt.Errorf("Petid: %s - Pettype: %s, not available", a.PetID, a.PetType)
		return NewBadRequestError("pet not available", err)
	}

	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		ErrorWithTrace(ctx, logger, "err", err)
		span.RecordError(err)
		return NewInternalError("failed to read pet validation response", err)
	}

	sb := string(body)
	LogWithTrace(ctx, logger, "response_body", sb)

	var pets []Pet
	if err := json.Unmarshal(body, &pets); err != nil {
		ErrorWithTrace(ctx, logger, "err", err)
		span.RecordError(err)
		return NewInternalError("failed to parse pet validation response", err)
	}

	if len(pets) == 0 {
		err := fmt.Errorf("pet not found: petId=%s, petType=%s", a.PetID, a.PetType)
		return NewNotFoundError("pet not found", err)
	}

	// Check if pet is available for adoption
	pet := pets[0]
	if pet.Availability != "yes" {
		err := fmt.Errorf("pet not available for adoption: petId=%s, availability=%s", a.PetID, pet.Availability)
		return NewBadRequestError("pet not available for adoption", err)
	}

	return nil
}

// ResetPetsAvailability updates every adopted pet to availability = yes
// through pet updater using concurrent goroutines.
// Returns the list of successfully reset pets so only those transactions can be deleted.
func (r *repo) ResetPetsAvailability(ctx context.Context) ([]PetIdentifier, error) {
	logger := log.With(r.logger, "method", "ResetPetsAvailability")
	span := trace.SpanFromContext(ctx)
	span.AddEvent("resetting pet availability for all adopted pets")

	// 连同主键 id 一起读 —— **不要用 DISTINCT**。
	//
	// 我们必须知道「这一轮看到的到底是哪几行」，否则第 4 步按 (pet_id,
	// pet_type) 删，会连带删掉读列表之后新产生的交易行，让那只宠物变成
	// availability='no' 且无交易行，从而永远回不到流通里（这个列表就来自
	// transactions）。按 id 删是这个竞态唯一的闭合办法。
	sql := "SELECT id, pet_id, pet_type FROM transactions"
	rows, err := r.db.QueryContext(ctx, sql)
	if err != nil {
		span.RecordError(err)
		ErrorWithTrace(ctx, logger, "error", "failed to query pet transactions", "err", err)
		return nil, NewInternalError("failed to query pet transactions from database", err)
	}
	defer rows.Close()

	// 按 (pet_id, pet_type) 聚合，保留每只宠物本轮观察到的全部行主键。
	type petInfo struct {
		petID   string
		petType string
		txnIDs  []int64
	}
	var pets []petInfo
	idx := make(map[string]int, 32)

	for rows.Next() {
		var (
			id      int64
			petID   string
			petType string
		)
		if err := rows.Scan(&id, &petID, &petType); err != nil {
			span.RecordError(err)
			ErrorWithTrace(ctx, logger, "error", "failed to scan pet row", "err", err)
			return nil, NewInternalError("failed to scan pet data", err)
		}
		key := petKey(petID, petType)
		if i, ok := idx[key]; ok {
			pets[i].txnIDs = append(pets[i].txnIDs, id)
			continue
		}
		idx[key] = len(pets)
		pets = append(pets, petInfo{petID: petID, petType: petType, txnIDs: []int64{id}})
	}

	if err := rows.Err(); err != nil {
		span.RecordError(err)
		ErrorWithTrace(ctx, logger, "error", "error iterating pet rows", "err", err)
		return nil, NewInternalError("error iterating pet rows", err)
	}

	InfoWithTrace(ctx, logger, "action", "pets_to_reset", "count", len(pets))

	// ── 自愈：把 DynamoDB 里 availability='no' 却**没有交易行**的宠物也补进来 ──
	//
	// 为什么单靠 transactions 不够（2026-10-04 实测）：
	//
	// CompleteAdoption 的顺序是 CreateTransaction（service.go:99）→
	// UpdateAvailability（service.go:106）。cleanup 每约 8 秒跑一次，比领养
	// 还频繁，所以它会落在这两行**之间**：
	//
	//   1. 领养：CreateTransaction(X) → 交易行存在，X 仍是 'yes'
	//   2. cleanup：**合法地**读到这行 → 重置 X（本就是 yes，空操作）→ 删掉这行
	//   3. 领养：UpdateAvailability → X 变 'no'
	//   4. X 是 'no' 且无交易行 → 而重置列表来自 transactions → 永远回不来
	//
	// ⚠️ 这跟 a01fa93d 修的不是同一个竞态。那次是「删掉了读列表之后新产生的
	//    行」，按行主键删即可闭合；这次那行**是被正当观察到的**，按主键删
	//    一样会删它。实测 22 小时内成功率又从 94.4% 单调掉到 38.1%，
	//    26 只里 15 只被孤立。
	//
	// 所以不再逐个去堵窗口 —— 改成让重置**自愈**：凡 availability='no' 的
	// 宠物都进重置列表，不管它有没有交易行。这样任何孤立路径（包括将来
	// 新引入的）都能在一个 cleanup 周期内自我纠正。
	//
	// 这些宠物的 TxnIDs 为空，所以删除那一步不会为它们删任何行 —— 它们本来
	// 就没有行。扫描失败**刻意不中断重置**，只降级为「仅 transactions」
	// 并响亮地记错误：这个补全是安全网，不该让安全网失效连坐主路径。
	if orphans, err := r.unavailablePetsWithoutTxn(ctx, idx); err != nil {
		ErrorWithTrace(ctx, logger, "error", "orphan_scan_failed",
			"message", "降级为仅用 transactions —— 被孤立的宠物本轮不会被复原", "err", err)
	} else if len(orphans) > 0 {
		for _, o := range orphans {
			pets = append(pets, petInfo{petID: o.PetID, petType: o.PetType})
		}
		InfoWithTrace(ctx, logger, "action", "orphans_recovered",
			"count", len(orphans), "totalToReset", len(pets))
	}

	// Use goroutines to reset availability for each pet concurrently
	var wg sync.WaitGroup
	successChan := make(chan PetIdentifier, len(pets))
	errorChan := make(chan error, len(pets))

	for _, pet := range pets {
		wg.Add(1)
		go func(p petInfo) {
			defer wg.Done()
			// Reset availability to "yes" to make pets available again
			req := completeAdoptionRequest{
				PetId:           p.petID,
				PetType:         p.petType,
				PetAvailability: "yes",
			}
			if err := r.callPetUpdater(ctx, req); err != nil {
				ErrorWithTrace(ctx, logger, "error", "failed to reset pet availability", "petID", p.petID, "petType", p.petType, "err", err)
				errorChan <- err
			} else {
				InfoWithTrace(ctx, logger, "action", "pet_availability_reset", "petID", p.petID, "petType", p.petType)
				successChan <- PetIdentifier{PetID: p.petID, PetType: p.petType, TxnIDs: p.txnIDs}
			}
		}(pet)
	}

	// Wait for all goroutines to complete
	wg.Wait()
	close(successChan)
	close(errorChan)

	// Collect successfully reset pets
	var successfulResets []PetIdentifier
	for pet := range successChan {
		successfulResets = append(successfulResets, pet)
	}

	// Collect errors
	var resetErrors []error
	for err := range errorChan {
		resetErrors = append(resetErrors, err)
	}

	if len(resetErrors) > 0 {
		WarnWithTrace(ctx, logger, "warning", "some pets failed to reset",
			"errorCount", len(resetErrors),
			"successCount", len(successfulResets),
			"totalCount", len(pets))
	}

	InfoWithTrace(ctx, logger, "action", "pets_reset_completed",
		"successCount", len(successfulResets),
		"failedCount", len(resetErrors),
		"totalCount", len(pets))

	return successfulResets, nil
}

type Pet struct {
	Availability string `dynamo:"availability"`
	CutenessRate string `json:"cuteness_rate" dynamo:"cuteness_rate"`
	PetColor     string `dynamo:"petcolor,"`
	PetID        string `dynamo:"petid"`
	PetType      string `dynamo:"pettype"`
	Image        string `dynamo:"image"`
	Price        string `dynamo:"price"`
}

// petKey 是 (petID, petType) 的唯一键。
//
// ⚠️ 只能有这一个地方拼这个键。我第一版在调用方用 petID+petType、
//    在扫描里用 petType+petID，顺序不一致 —— 去重会**静默失效**
//    （没有报错，只是每轮把已在列表里的宠物再加一次）。
func petKey(petID, petType string) string { return petID + "\x00" + petType }

// unavailablePetsWithoutTxn 返回 DynamoDB 里 availability='no'、而**不在**
// seen 里的宠物 —— 也就是「被孤立」的那些。
//
// 它是 ResetPetsAvailability 的安全网。单靠 `transactions` 推导重置列表有一个
// 无法靠「删得更精确」闭合的竞态（见 ResetPetsAvailability 里的说明）：
// 交易行可能在宠物被置为 'no' **之前**就被一次正当的 cleanup 删掉了，
// 此后那只宠物在 transactions 里不留任何痕迹。
//
// ⚠️ 判据刻意是「availability='no'」而不是「有没有交易行」——
//    后者正是那个有缺陷的推导方式。可用性是宠物是否在流通的**权威事实**，
//    交易行只是它的一个副产品。
// seen 直接用调用方已有的那张「键 → pets 下标」映射，**不另建一份** ——
// 两份映射就有两处可能把键拼错。
func (r *repo) unavailablePetsWithoutTxn(ctx context.Context, seen map[string]int) ([]PetIdentifier, error) {
	ctx, span := r.cfg.Tracer.Start(ctx, "DDB scan unavailable pets")
	defer span.End()

	if r.cfg.DynamoDBTable == "" {
		return nil, errors.New("DynamoDBTable 未配置")
	}

	// 与 TriggerSeeding 一致地处理接口端点 —— 集群里走 VPC 端点，
	// 抄错这段会让扫描在有端点的环境里走公网而超时。
	var awsCfg aws.Config
	if r.cfg.DDBInterfaceEndpoint != "" {
		awsCfg = r.cfg.AWSCfg.Copy()
		awsCfg.BaseEndpoint = aws.String(r.cfg.DDBInterfaceEndpoint)
	} else {
		awsCfg = r.cfg.AWSCfg
	}

	var found []Pet
	err := dynamo.New(awsCfg).Table(r.cfg.DynamoDBTable).
		Scan().
		Filter("$ = ?", "availability", "no").
		Project("petid", "pettype").
		All(ctx, &found)
	if err != nil {
		span.RecordError(err)
		return nil, err
	}

	var out []PetIdentifier
	for _, p := range found {
		if p.PetID == "" || p.PetType == "" {
			continue
		}
		if _, ok := seen[petKey(p.PetID, p.PetType)]; ok {
			continue
		}
		out = append(out, PetIdentifier{PetID: p.PetID, PetType: p.PetType})
	}
	return out, nil
}

func (r *repo) TriggerSeeding(ctx context.Context) error {
	span := trace.SpanFromContext(ctx)
	ctx, ddbSpan := r.cfg.Tracer.Start(ctx, "DDB seed")

	seedRawData, err := r.fetchSeedData()

	if err != nil {
		ErrorWithTrace(ctx, r.logger, "err", err)
		span.RecordError(err)
		return err
	}

	var pets []Pet

	if err := json.Unmarshal([]byte(seedRawData), &pets); err != nil {
		ErrorWithTrace(ctx, r.logger, "err", err)
		span.RecordError(err)
		return err
	}

	var awsCfg aws.Config
	if r.cfg.DDBInterfaceEndpoint != "" {
		awsCfg = r.cfg.AWSCfg.Copy()
		awsCfg.BaseEndpoint = aws.String(r.cfg.DDBInterfaceEndpoint)
	} else {
		awsCfg = r.cfg.AWSCfg
	}
	db := dynamo.New(awsCfg)
	table := db.Table(r.cfg.DynamoDBTable)

	bw := table.Batch().Write()
	for _, i := range pets {
		bw = bw.Put(i)
	}

	res, err := bw.Run(ctx)

	r.logger.Log("res", res, "err", err)
	ddbSpan.End()

	ctx, pgSpan := r.cfg.Tracer.Start(ctx, "PG create tables")
	defer pgSpan.End()
	sqlErr := r.CreateSQLTables(ctx)
	if sqlErr != nil {
		span.RecordError(sqlErr)
		return sqlErr
	}

	return nil

}

func (r *repo) fetchSeedData() (string, error) {

	data, err := os.ReadFile("seed.json")
	if err != nil {
		r.logger.Log("err", err)
	}

	return string(data), nil
}

func (r *repo) ErrorModeOn(ctx context.Context) bool {

	svc := ssm.NewFromConfig(r.cfg.AWSCfg)

	res, err := svc.GetParameter(ctx, &ssm.GetParameterInput{
		Name: aws.String("/petstore/errormode1"),
	})

	if err != nil {
		return false
	}

	return aws.ToString(res.Parameter.Value) == "true"
}

func (r *repo) CreateSQLTables(ctx context.Context) error {
	// cSpell:ignore VARCHAR
	sql := `CREATE TABLE IF NOT EXISTS transactions (
		id SERIAL PRIMARY KEY,
		pet_id VARCHAR,
		pet_type VARCHAR,
		adoption_date DATE,
		transaction_id VARCHAR,
		user_id VARCHAR
	);`

	r.logger.Log("sql", sql)
	_, err := r.db.ExecContext(ctx, sql)
	if err != nil {
		return err
	}

	return nil
}

// GetConnectionString retrieves the database connection string for error mode scenarios
func (r *repo) GetConnectionString(ctx context.Context) (string, error) {
	return r.dbSvc.GetConnectionString(ctx)
}
