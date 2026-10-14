@echo off
if not defined CC_FAKE_RUNNER_STATE exit /b 42
if not exist "%CC_FAKE_RUNNER_STATE%" (
  >"%CC_FAKE_RUNNER_STATE%" echo first-attempt
  >>"%CC_FAKE_RUNNER_STATE%" echo args=%*
  >>"%CC_FAKE_RUNNER_STATE%" echo codex-home=%CODEX_HOME%
  >>"%CC_FAKE_RUNNER_STATE%" echo model=%MODEL_GATEWAY_MODEL%
  >>"%CC_FAKE_RUNNER_STATE%" echo gateway-base=%CLAUDE_CODE_GATEWAY_BASE_URL%
  >>"%CC_FAKE_RUNNER_STATE%" echo gateway-token=%CLAUDE_CODE_GATEWAY_TOKEN%
  >>"%CC_FAKE_RUNNER_STATE%" echo gateway-mode=%CLAUDE_CODE_USE_GATEWAY%
  >>"%CC_FAKE_RUNNER_STATE%" echo anthropic-auth=%ANTHROPIC_AUTH_TOKEN%
  >>"%CC_FAKE_RUNNER_STATE%" echo anthropic-model=%ANTHROPIC_MODEL%
  >>"%CC_FAKE_RUNNER_STATE%" echo anthropic-api-key-present=0
  if defined ANTHROPIC_API_KEY >>"%CC_FAKE_RUNNER_STATE%" echo anthropic-api-key-present=1
  >>"%CC_FAKE_RUNNER_STATE%" echo anthropic-custom-headers-present=0
  if defined ANTHROPIC_CUSTOM_HEADERS >>"%CC_FAKE_RUNNER_STATE%" echo anthropic-custom-headers-present=1
  >>"%CC_FAKE_RUNNER_STATE%" echo bedrock-provider-present=0
  if defined CLAUDE_CODE_USE_BEDROCK >>"%CC_FAKE_RUNNER_STATE%" echo bedrock-provider-present=1
  >>"%CC_FAKE_RUNNER_STATE%" echo vertex-provider-present=0
  if defined CLAUDE_CODE_USE_VERTEX >>"%CC_FAKE_RUNNER_STATE%" echo vertex-provider-present=1
  >>"%CC_FAKE_RUNNER_STATE%" echo foundry-provider-present=0
  if defined CLAUDE_CODE_USE_FOUNDRY >>"%CC_FAKE_RUNNER_STATE%" echo foundry-provider-present=1
  >>"%CC_FAKE_RUNNER_STATE%" echo gateway-options=%MODEL_GATEWAY_MODEL_OPTIONS%
  >>"%CC_FAKE_RUNNER_STATE%" echo disable-sm=%DISABLE_CLAUDE_CODE_SM_COMPACT%
  exit /b 42
)
>>"%CC_FAKE_RUNNER_STATE%" echo second-attempt
>>"%CC_FAKE_RUNNER_STATE%" echo args=%*
>>"%CC_FAKE_RUNNER_STATE%" echo disable-sm=%DISABLE_CLAUDE_CODE_SM_COMPACT%
exit /b 0
