package helps

import (
	"fmt"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/registry"
	"github.com/router-for-me/CLIProxyAPI/v7/internal/thinking"
	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

// Translation drops non-standard fields. Recover only the Qoder context control
// from the original envelope; never merge arbitrary original request fields.
func ApplyQoderRuntimeOptions(payload, original []byte, options *registry.QoderRuntimeOptions) ([]byte, error) {
	context := gjson.GetBytes(original, "context_length")
	if !context.Exists() {
		context = gjson.GetBytes(payload, "context_length")
	}
	window := int64(0)
	if context.Exists() {
		if context.Type != gjson.Number || context.Float() <= 0 || context.Float() > 1e9 || context.Float() != float64(context.Int()) {
			return nil, fmt.Errorf("invalid Qoder context_length")
		}
		window = context.Int()
	}
	effort := thinking.ExtractTranslatedReasoningEffort(payload, "openai")
	for _, path := range []string{"reasoning.effort", "reasoning_effort", "output_config.effort"} {
		if value := gjson.GetBytes(original, path); value.Type == gjson.String && value.String() != "" {
			effort = value.String()
			break
		}
	}
	if gjson.GetBytes(original, "thinking.type").String() == "disabled" {
		effort = "none"
	}
	if options != nil {
		if window == 0 {
			window = int64(options.DefaultContext)
		}
		if window > 0 && len(options.ContextWindows) > 0 {
			found := false
			for _, n := range options.ContextWindows {
				if int64(n) == window {
					found = true
				}
			}
			if !found {
				return nil, fmt.Errorf("Qoder context_length is not advertised by this account model")
			}
		}
		if effort == "" {
			effort = options.DefaultEffort
		}
		if effort != "" && options.ThinkingDeclared {
			found := false
			for _, level := range options.Levels {
				if effort == level {
					found = true
				}
			}
			if !found {
				return nil, fmt.Errorf("Qoder reasoning_effort is not advertised by this account model")
			}
		}
	}
	var err error
	if window > 0 {
		payload, err = sjson.SetBytes(payload, "context_length", window)
		if err != nil {
			return nil, err
		}
	}
	if effort != "" {
		payload, err = sjson.SetBytes(payload, "reasoning_effort", effort)
	}
	return payload, err
}
