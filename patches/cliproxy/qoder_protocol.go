package helps

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/md5"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/thinking"
	"github.com/tidwall/gjson"
)

const (
	QoderDefaultChatURL = "https://api3.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1"
	QoderGatewayVersion = "1.1.38"
	QoderClientType     = "5"
	QoderDataPolicy     = "disagree"
	QoderLoginVersion   = "v2"
	QoderMachineType    = "5"
	QoderMachineOS      = "aarch64_linux"

	qoderCustomAlphabet = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!"
	qoderStdAlphabet    = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

	qoderRSAPublicKeyPEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`
)

var (
	qoderEncodeTable     [256]byte
	qoderEncodeTableOnce sync.Once
	qoderRSAPubKey       *rsa.PublicKey
	qoderRSAPubKeyOnce   sync.Once
	qoderRSAPubKeyErr    error
)

func initQoderEncodeTable() {
	for i := 0; i < 256; i++ {
		qoderEncodeTable[i] = byte(i)
	}
	for i := 0; i < len(qoderStdAlphabet); i++ {
		qoderEncodeTable[qoderStdAlphabet[i]] = qoderCustomAlphabet[i]
	}
	qoderEncodeTable['='] = '$'
}

func getQoderRSAPublicKey() (*rsa.PublicKey, error) {
	qoderRSAPubKeyOnce.Do(func() {
		block, _ := pem.Decode([]byte(qoderRSAPublicKeyPEM))
		if block == nil {
			qoderRSAPubKeyErr = errors.New("failed to decode Qoder RSA public key PEM")
			return
		}
		pub, err := x509.ParsePKIXPublicKey(block.Bytes)
		if err != nil {
			qoderRSAPubKeyErr = fmt.Errorf("failed to parse Qoder RSA public key: %w", err)
			return
		}
		rsaPub, ok := pub.(*rsa.PublicKey)
		if !ok {
			qoderRSAPubKeyErr = errors.New("parsed key is not an RSA public key")
			return
		}
		qoderRSAPubKey = rsaPub
	})
	return qoderRSAPubKey, qoderRSAPubKeyErr
}

// QoderEncodeBody encodes plaintext into Qoder custom alphabet with permuted blocks.
func QoderEncodeBody(plaintext []byte) []byte {
	qoderEncodeTableOnce.Do(initQoderEncodeTable)

	std := base64.StdEncoding.EncodeToString(plaintext)
	n := len(std)
	a := n / 3
	out := make([]byte, n)
	dst := 0
	for i := n - a; i < n; i++ {
		out[dst] = qoderEncodeTable[std[i]]
		dst++
	}
	for i := a; i < n-a; i++ {
		out[dst] = qoderEncodeTable[std[i]]
		dst++
	}
	for i := 0; i < a; i++ {
		out[dst] = qoderEncodeTable[std[i]]
		dst++
	}
	return out
}

// AES128CBCEncrypt encrypts plaintext with AES-128-CBC using key both as key and IV.
func AES128CBCEncrypt(plaintext, key []byte) (string, error) {
	block, errBlock := aes.NewCipher(key)
	if errBlock != nil {
		return "", errBlock
	}

	// PKCS#7 padding
	padLen := aes.BlockSize - (len(plaintext) % aes.BlockSize)
	padded := make([]byte, len(plaintext)+padLen)
	copy(padded, plaintext)
	copy(padded[len(plaintext):], bytes.Repeat([]byte{byte(padLen)}, padLen))

	ciphertext := make([]byte, len(padded))
	mode := cipher.NewCBCEncrypter(block, key)
	mode.CryptBlocks(ciphertext, padded)

	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

// RSAEncryptBase64 encrypts data with Qoder RSA public key and PKCS1v15 padding.
func RSAEncryptBase64(data []byte) (string, error) {
	pub, errPub := getQoderRSAPublicKey()
	if errPub != nil {
		return "", errPub
	}
	encrypted, errEncrypt := rsa.EncryptPKCS1v15(rand.Reader, pub, data)
	if errEncrypt != nil {
		return "", errEncrypt
	}
	return base64.StdEncoding.EncodeToString(encrypted), nil
}

// ComputeQoderSigPath extracts the signature path from the request URL, stripping "/algo".
func ComputeQoderSigPath(requestURL string) string {
	parsed, err := url.Parse(requestURL)
	if err != nil {
		return "/api/v2/service/pro/sse/agent_chat_generation"
	}
	sigPath := parsed.Path
	if strings.HasPrefix(sigPath, "/algo") {
		sigPath = sigPath[len("/algo"):]
	}
	return sigPath
}

// BuildQoderAuthHeaders builds all required Cosy/Qoder authentication headers.
func BuildQoderAuthHeaders(bodyBytes []byte, requestURL, uid, accessToken, email string) (map[string]string, error) {
	if strings.TrimSpace(uid) == "" {
		return nil, errors.New("qoder: user id is empty")
	}
	if strings.TrimSpace(accessToken) == "" {
		return nil, errors.New("qoder: access token is empty")
	}

	aesKey := []byte(strings.ReplaceAll(uuid.NewString(), "-", "")[:16])

	userInfo := map[string]string{
		"uid":                  uid,
		"security_oauth_token": accessToken,
		"name":                 "",
		"aid":                  "",
		"email":                email,
	}
	userInfoJSON, errJSON := json.Marshal(userInfo)
	if errJSON != nil {
		return nil, errJSON
	}

	infoB64, errAES := AES128CBCEncrypt(userInfoJSON, aesKey)
	if errAES != nil {
		return nil, errAES
	}

	cosyKey, errRSA := RSAEncryptBase64(aesKey)
	if errRSA != nil {
		return nil, errRSA
	}

	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	requestID := uuid.NewString()
	cosyPayload := map[string]string{
		"version":     "v1",
		"requestId":   requestID,
		"info":        infoB64,
		"cosyVersion": QoderGatewayVersion,
		"ideVersion":  "",
	}
	cosyPayloadJSON, _ := json.Marshal(cosyPayload)
	payloadB64 := base64.StdEncoding.EncodeToString(cosyPayloadJSON)

	sigPath := ComputeQoderSigPath(requestURL)

	h := md5.New()
	h.Write([]byte(payloadB64))
	h.Write([]byte("\n"))
	h.Write([]byte(cosyKey))
	h.Write([]byte("\n"))
	h.Write([]byte(timestamp))
	h.Write([]byte("\n"))
	h.Write(bodyBytes)
	h.Write([]byte("\n"))
	h.Write([]byte(sigPath))
	sig := hex.EncodeToString(h.Sum(nil))

	bh := md5.New()
	bh.Write(bodyBytes)
	bodyHash := hex.EncodeToString(bh.Sum(nil))
	bodyLen := strconv.Itoa(len(bodyBytes))

	machineID := strings.ReplaceAll(uuid.NewString(), "-", "")[:32]

	headers := map[string]string{
		"Authorization":          fmt.Sprintf("Bearer COSY.%s.%s", payloadB64, sig),
		"Cosy-Key":               cosyKey,
		"Cosy-User":              uid,
		"Cosy-Date":              timestamp,
		"Cosy-Version":           QoderGatewayVersion,
		"Cosy-Machineid":         machineID,
		"Cosy-Machinetoken":      machineID,
		"Cosy-Machinetype":       QoderMachineType,
		"Cosy-Machineos":         QoderMachineOS,
		"Cosy-Clienttype":        QoderClientType,
		"Cosy-Clientip":          "127.0.0.1",
		"Cosy-Bodyhash":          bodyHash,
		"Cosy-Bodylength":        bodyLen,
		"Cosy-Sigpath":           sigPath,
		"Cosy-Data-Policy":       QoderDataPolicy,
		"Cosy-Organization-Id":   "",
		"Cosy-Organization-Tags": "",
		"Login-Version":          QoderLoginVersion,
		"X-Request-Id":           uuid.NewString(),
		"Content-Type":           "application/json",
		"Accept":                 "text/event-stream",
		"Cache-Control":          "no-cache",
		"Accept-Encoding":        "identity",
	}
	return headers, nil
}

// NormalizeQoderModel maps requested model name to Qoder upstream model key and reasoning flag.
func NormalizeQoderModel(requested string) (key string, isReasoning bool) {
	lower := strings.ToLower(strings.TrimSpace(requested))
	lower = strings.TrimPrefix(lower, "qoder/")
	switch lower {
	case "qmodel_38max", "qwen3.8-max", "qwen-3.8-max", "qwen3.8_max":
		return "qmodel_38max", true
	case "qmodel_preview":
		return "qmodel_preview", true
	case "qmodel", "qwen3.7-plus", "qwen-3.7-plus", "qwen3.7plus":
		return "qmodel", false
	case "qmodel_latest", "qwen3.7-max", "qwen-3.7-max", "qwen3.7max":
		return "qmodel_latest", true
	case "qfmodel", "q36fmodel", "qwen3.8-flash", "qwen-3.8-flash":
		return "qfmodel", false
	case "cmodel", "cantus":
		return "cmodel", true
	case "dmodel", "deepseek-v4-pro", "deepseek-v4":
		return "dmodel", true
	case "dfmodel", "deepseek-v4-flash":
		return "dfmodel", false
	case "kmodel", "kimi-k2.7-code", "kimi-k2.7":
		return "kmodel", true
	case "kmodel_latest", "kimi-k3":
		return "kmodel_latest", true
	case "gm51model", "glm-5.2", "glm5.2":
		return "gm51model", true
	case "mmodel", "minimax-m3", "minimax-m2.7":
		return "mmodel", false
	case "auto":
		return "auto", true
	case "ultimate":
		return "ultimate", true
	case "performance":
		return "performance", true
	case "efficient":
		return "efficient", false
	case "lite":
		return "lite", false
	default:
		if lower != "" {
			return lower, false
		}
		return "auto", true
	}
}

// BuildQoderRequestBody converts an inbound OpenAI payload into Qoder's native agent_chat_generation payload.
func BuildQoderRequestBody(payload []byte, modelKey string, isReasoning bool) ([]byte, error) {
	recordID := uuid.NewString()
	sessionID := uuid.NewString()

	parsed := gjson.ParseBytes(payload)
	effort := thinking.ExtractTranslatedReasoningEffort(payload, "openai")
	if effort != "" {
		isReasoning = effort != string(thinking.LevelNone)
	}

	var messages []map[string]any
	var lastUserText string
	var systemParts []string
	for _, m := range parsed.Get("messages").Array() {
		role := m.Get("role").String()
		content := m.Get("content")
		text := content.String()
		if content.IsArray() {
			var parts []string
			for _, part := range content.Array() {
				if part.Get("type").String() == "text" {
					parts = append(parts, part.Get("text").String())
				}
			}
			text = strings.Join(parts, "\n")
		}
		if role == "system" || role == "developer" {
			systemParts = append(systemParts, text)
			// The native service consumes system instructions from messages;
			// the top-level system field alone is not sufficient.
			if text != "" {
				messages = append(messages, map[string]any{"role": "system", "content": text})
			}
			continue
		}
		if role == "user" {
			lastUserText = text
		}
		var message map[string]any
		if err := json.Unmarshal([]byte(m.Raw), &message); err != nil {
			return nil, err
		}
		// Qoder drops a tool-only assistant row when content is absent/null,
		// leaving the following tool result without its preceding tool_calls.
		if role == "assistant" && m.Get("tool_calls").IsArray() && (!content.Exists() || content.Type == gjson.Null) {
			message["content"] = ""
		}
		messages = append(messages, message)
	}

	if lastUserText == "" {
		lastUserText = "hello"
	}

	parameters := map[string]any{
		"enable_thinking": isReasoning,
	}
	if effort != "" {
		parameters["reasoning_effort"] = effort
	}
	if window := parsed.Get("context_length"); window.Exists() {
		parameters["context_length"] = window.Int()
	}

	reqBody := map[string]any{
		"request_id":       uuid.NewString(),
		"request_set_id":   recordID,
		"chat_record_id":   recordID,
		"session_id":       sessionID,
		"stream":           true,
		"chat_task":        "FREE_INPUT",
		"is_reply":         true,
		"is_retry":         false,
		"source":           1,
		"version":          "3",
		"session_type":     "qodercli",
		"agent_id":         "agent_common",
		"task_id":          "common",
		"code_language":    "",
		"chat_prompt":      "",
		"image_urls":       nil,
		"aliyun_user_type": "",
		"system":           strings.Join(systemParts, "\n"),
		"messages":         messages,
		"tools":            []any{},
		"parameters":       parameters,
		"chat_context": map[string]any{
			"chatPrompt": "",
			"imageUrls":  nil,
			"extra": map[string]any{
				"context": []any{},
				"modelConfig": map[string]any{
					"key":          modelKey,
					"is_reasoning": isReasoning,
				},
				"originalContent": lastUserText,
			},
			"features": []any{},
			"text":     lastUserText,
		},
		// The top-level key selects the billed upstream model; the context and
		// X-Model-Key header alone do not select the same accounting path.
		"model_config": map[string]any{
			"key":          modelKey,
			"is_reasoning": isReasoning,
			"source":       "system",
		},
		"business": map[string]any{
			"product":  "cli",
			"version":  "1.0.0",
			"type":     "agent",
			"stage":    "start",
			"id":       uuid.NewString(),
			"name":     lastUserText,
			"begin_at": time.Now().UnixMilli(),
		},
	}

	if tools := parsed.Get("tools"); tools.IsArray() {
		reqBody["tools"] = tools.Value()
	}
	for _, key := range []string{"tool_choice", "parallel_tool_calls"} {
		if value := parsed.Get(key); value.Exists() {
			reqBody[key] = value.Value()
		}
	}
	for _, key := range []string{"max_tokens", "temperature", "top_p", "stop"} {
		if value := parsed.Get(key); value.Exists() {
			parameters[key] = value.Value()
		}
	}
	return json.Marshal(reqBody)
}
