package petlistadoptions

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sync"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/go-kit/log"
	"github.com/go-kit/log/level"
	"go.opentelemetry.io/contrib/instrumentation/net/http/otelhttp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"
)

// Repository as an interface to define data store interactions
type Repository interface {
	GetLatestAdoptions(ctx context.Context, petSearchURL string) ([]Adoption, error)
}

type Config struct {
	PetSearchURL      string
	RDSSecretArn      string
	RDSReaderEndpoint string
	Tracer            trace.Tracer
	AWSCfg            aws.Config
}

// repo as an implementation of Repository with dependency injection
type repo struct {
	db          *sql.DB
	logger      log.Logger
	safeConnStr string
}

func NewRepository(db *sql.DB, logger log.Logger, safeConnStr string) Repository {
	return &repo{
		db:          db,
		logger:      logger,
		safeConnStr: safeConnStr,
	}
}

type transaction struct {
	TransactionID string
	PetID         string
	AdoptionDate  time.Time
}

type pet struct {
	Availability string `json:"availability,omitempty"`
	CutenessRate string `json:"cuteness_rate,omitempty"`
	PetColor     string `json:"petcolor,omitempty"`
	PetID        string `json:"petid,omitempty"`
	PetType      string `json:"pettype,omitempty"`
	PetURL       string `json:"peturl,omitempty"`
	Price        string `json:"price,omitempty"`
}

func (r *repo) GetLatestAdoptions(ctx context.Context, petSearchURL string) ([]Adoption, error) {
	logger := log.With(r.logger, "method", "GetTopTransactions")

	tracer := otel.GetTracerProvider().Tracer("petlistadoptions")
	_, span := tracer.Start(ctx, "PGSQL Query", trace.WithSpanKind(trace.SpanKindClient))

	sql := `SELECT pet_id, transaction_id, adoption_date FROM transactions ORDER BY id DESC LIMIT 25`
	// TODO: implement native sql instrumentation when issue is closed.
	// https://github.com/open-telemetry/opentelemetry-go-contrib/issues/5
	//rows, err := r.db.QueryContext(ctx, sql)

	span.SetAttributes(
		attribute.String("sql", sql),
		attribute.String("url", r.safeConnStr),
	)

	rows, err := r.db.Query(sql)
	if err != nil {
		logger.Log("error", err)
		return nil, err
	}
	span.End()

	var wg sync.WaitGroup
	adoptions := make(chan Adoption)

	for rows.Next() {
		t := transaction{}

		err := rows.Scan(&t.PetID, &t.TransactionID, &t.AdoptionDate)

		if err != nil {
			level.Error(logger).Log("err", err)
			continue
		}
		wg.Add(1)
		go searchForPet(ctx, r.logger, &wg, adoptions, t, petSearchURL)
	}

	go func() {
		wg.Wait()
		close(adoptions)
	}()

	res := []Adoption{}

	for i := range adoptions {
		logger.Log("petid", i.PetID, "pettype", i.PetType, "petcolor", i.PetColor, "xrayTraceId", getXrayTraceID(span))
		res = append(res, i)
	}

	return res, nil
}

// searchTransport 是包级共享的 HTTP Transport。
//
// 为什么必须包级共享：连接池活在 Transport 里，不在 http.Client 里。
// 每次调用新建 Client 但复用同一个 Transport 是可以的；但每次新建 Transport
// 会让每个请求都开新连接，池完全失效。
//
// 为什么要调大 MaxIdleConnsPerHost：GetLatestAdoptions 为每个 adoption 起一个
// goroutine 调 search-service（2026-08-30 实测扇出 11.5 次/请求），而
// http.DefaultTransport 的 MaxIdleConnsPerHost 默认只有 2
// （Go 的 DefaultMaxIdleConnsPerHost），于是约 9 条并发连接用完即关、无法复用 ——
// 实测复用率仅 1.94 请求/连接，新建连接 17.1 个/秒。
// 取 32 是给实测的 11.5 倍扇出留出余量（HPA 最多 6 副本时单副本扇出不会更高）。
//
// 用 Clone() 而不是裸 &http.Transport{}：后者会丢掉 DefaultTransport 的
// 30 秒 dial 超时、ProxyFromEnvironment 与 TLS 握手超时 —— DialContext 为 nil 时
// http.Transport 使用无超时的零值 Dialer，连接不上的对端会一直挂着。
var searchTransport = func() *http.Transport {
	t := http.DefaultTransport.(*http.Transport).Clone()
	t.MaxIdleConns = 100
	t.MaxIdleConnsPerHost = 32
	t.IdleConnTimeout = 90 * time.Second
	return t
}()

// searchClient 复用上面的 Transport。Timeout 覆盖整个请求（含连接、重定向、读 body），
// 原实现没有任何超时 —— search-service 挂住会让 goroutine 与连接无限期泄漏，
// 而每个入站请求会扇出 11.5 个这样的 goroutine。
var searchClient = &http.Client{
	Transport: otelhttp.NewTransport(searchTransport),
	Timeout:   15 * time.Second,
}

func searchForPet(ctx context.Context, logger log.Logger, wg *sync.WaitGroup, queue chan Adoption, t transaction, petSearchURL string) {
	logger = log.With(logger, "method", "searchForPet", "petid", t.PetID)
	defer wg.Done()

	url := fmt.Sprintf("%spetid=%s", petSearchURL, t.PetID)

	req, _ := http.NewRequestWithContext(ctx, "GET", url, nil)
	resp, err := searchClient.Do(req)
	if err != nil {
		level.Error(logger).Log("err", err)
		return
	}

	// 必须排空并关闭 body，否则连接不会被放回空闲池。
	//
	// 原实现完全没有 Close：正常路径下 json.Decode 恰好读到 EOF 时 net/http 仍会
	// 归还连接（所以复用率是 1.94 而不是 1.0），但错误路径直接 return 时
	// body 既没读完也没关，连接被彻底放弃，直到 IdleConnTimeout 才回收。
	// io.Copy 到 Discard 是为了确保读到 EOF —— json.Decoder 只读完第一个顶层值就停，
	// 尾部残留字节会让连接无法归还。
	defer func() {
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
	}()

	pets := []pet{}
	err = json.NewDecoder(resp.Body).Decode(&pets)
	if err != nil {
		level.Error(logger).Log("err", err)
		return
	}

	for _, p := range pets {
		// Merging elements from response. Result for petsearch is return as array

		queue <- Adoption{
			AdoptionDate:  t.AdoptionDate,
			Availability:  p.Availability,
			CutenessRate:  p.CutenessRate,
			PetColor:      p.PetColor,
			PetID:         p.PetID,
			PetType:       p.PetType,
			PetURL:        p.PetURL,
			Price:         p.Price,
			TransactionID: t.TransactionID,
		}
	}
}
