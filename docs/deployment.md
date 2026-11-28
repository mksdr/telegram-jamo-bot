# 배포와 설정

## 준비

[.node-version](../.node-version)에 지정된 Node.js 26과 npm, Cloudflare 계정, Telegram BotFather에서 발급한 봇 토큰이 필요합니다. 아래 명령은 저장소 루트에서 실행합니다.

봇을 대상 채팅에 추가하고 파일 게시 권한을 부여합니다. 그룹이나 채널에서 다른 사람이 올린 원본을 삭제하려면 봇에 해당 관리자 권한이 필요합니다. 그룹의 일반 파일 메시지를 받으려면 봇을 관리자로 지정하거나 BotFather의 privacy mode 설정을 확인하세요. 그룹을 사용하지 않는 봇은 BotFather의 `/setjoingroups`로 그룹 추가를 끌 수 있습니다. [BotFather 설정](https://core.telegram.org/bots/features#edit-settings)

## 로컬 실행

```sh
npm ci
cp .dev.vars.example .dev.vars
# .dev.vars에 테스트 봇 토큰과 웹훅 시크릿을 입력합니다.
npm run dev
```

Telegram에서 로컬 서버로 실제 웹훅을 받으려면 외부에서 접근할 수 있는 HTTPS 주소가 필요합니다. 자동 검증에서 Telegram 호출은 모의 처리합니다. [개발과 검증](../CONTRIBUTING.md#개발과-검증)

## 처리할 채팅 지정

개인용이나 지정 채팅 전용으로 운영할 때는 `ALLOWED_CHAT_IDS`에 채팅 ID를 쉼표로 구분해 지정합니다. 예를 들어 `123456789,-1001234567890`처럼 입력하고 그룹·채널 ID의 음수 부호를 유지합니다. 로컬에서는 `.dev.vars`에 입력합니다. 운영에서는 [wrangler.jsonc](../wrangler.jsonc)의 `vars`에 문자열로 설정하거나 `npx wrangler secret put ALLOWED_CHAT_IDS`를 실행해 입력합니다.

변수를 정의하지 않으면 봇이 업데이트를 받는 모든 채팅을 허용합니다. 빈 문자열, 잘못된 ID 항목, 문자열이 아닌 값은 설정 오류입니다. 정상 목록에 없는 채팅과 설정 오류가 있는 업데이트는 모두 HTTP 200으로 응답하며 Durable Object 조회와 Telegram API 호출을 건너뜁니다. 설정 오류는 `Invalid ALLOWED_CHAT_IDS configuration` 로그로 확인할 수 있습니다. [웹훅 응답](operations.md#웹훅-응답)

## 검색어 설정

[wrangler.jsonc](../wrangler.jsonc)의 `FULL_MODE_THRESHOLD` 기본값은 `"10"`입니다. 양의 정수를 문자열로 지정하면 그 길이 이하의 파일명에 초성·자모 검색어도 생성합니다. 설정이 비어 있거나 양의 정수로 해석되지 않으면 기본값을 사용합니다. 이미 진행 중인 업데이트는 처음 저장한 기준을 사용합니다. [검색어 생성](usage.md#검색어-생성)

## Cloudflare 배포

아래 명령으로 의존성을 설치하고 Wrangler에 로그인한 뒤 Worker를 배포합니다. [wrangler.jsonc](../wrangler.jsonc)에 포함된 `TELEGRAM_UPDATES` 바인딩과 SQLite 클래스 마이그레이션 `v1`이 첫 배포에 함께 적용됩니다. 나중에 바인딩을 바꾸면 `npm run cf-typegen`으로 타입을 다시 생성합니다.

```sh
npm ci
npx wrangler login
npm run deploy
```

웹훅을 등록하기 전에 두 값을 Workers Secrets에 저장합니다. 실제 값은 아래 명령의 입력 프롬프트에만 입력합니다. `wrangler secret put`은 새 Worker 버전을 즉시 배포합니다. [Cloudflare Workers Secrets](https://developers.cloudflare.com/workers/configuration/secrets/)

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
```

## Telegram 웹훅 등록

배포에 사용한 HTTPS 주소에 `/webhook`을 붙여 Telegram에 등록합니다. `secret_token`에는 Workers Secrets에 넣은 것과 같은 웹훅 시크릿을 입력합니다. 아래 예시는 Python 3가 필요하며 토큰과 시크릿을 화면에 표시하지 않는 프롬프트로 받습니다. [Telegram setWebhook](https://core.telegram.org/bots/api#setwebhook)

```sh
python3 -c '
import getpass
import json
import urllib.request

token = getpass.getpass("Telegram bot token: ")
secret = getpass.getpass("Webhook secret: ")
url = input("Webhook HTTPS URL (ending in /webhook): ").strip()
request = urllib.request.Request(
    f"https://api.telegram.org/bot{token}/setWebhook",
    data=json.dumps({"url": url, "secret_token": secret}).encode(),
    headers={"Content-Type": "application/json"},
)
with urllib.request.urlopen(request, timeout=15) as response:
    print("Webhook registered:", json.load(response)["ok"])
'
```

기존 `POST /` 경로도 지원합니다. `GET /health`와 `GET /`의 HTTP 200은 Worker가 요청에 응답한다는 뜻입니다. Telegram 연결과 권한은 테스트 채팅에 지원 파일을 올려 캡션이나 답글이 게시되는지 확인하세요. [운영과 장애 대응](operations.md)
