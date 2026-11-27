# 텔레그램 한글 자모 봇

[![GitHub License](https://img.shields.io/github/license/mksdr/telegram-jamo-bot)](LICENSE)
[![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/mksdr/telegram-jamo-bot/ci.yml)](https://github.com/mksdr/telegram-jamo-bot/actions/workflows/ci.yml)
![GitHub repo size](https://img.shields.io/github/repo-size/mksdr/telegram-jamo-bot)

텔레그램에 올린 파일을 한글 일부, 초성, 자모로 찾을 수 있도록 파일명에서 검색어를 생성하는 봇입니다. Cloudflare Workers에서 웹훅을 받아 검색어를 캡션과 답글로 게시합니다.

예를 들어 `한국.pdf`에서 `한국`, `ㅎㄱ`, `ㅎㅏㄴㄱㅜㄱ` 등의 검색어를 만듭니다.

## 사용된 Cloudflare 리소스

| 리소스                      | 용도                                                                                         |
| --------------------------- | -------------------------------------------------------------------------------------------- |
| Workers                     | Telegram 웹훅 수신, 인증, 검색어 생성 및 Bot API 호출                                        |
| SQLite 기반 Durable Objects | `TELEGRAM_UPDATES` 바인딩으로 봇·업데이트별 진행 상태 저장, 동시 요청 병합 및 중복 처리 방지 |
| Durable Object alarms       | 완료 기록은 7일 후, 미완료 기록은 60일 후 정리                                               |
| Workers Secrets             | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` 보관                                         |
| Workers Observability       | 처리 실패·보류·원본 삭제 실패 로그 확인                                                      |

Durable Objects의 SQLite 저장소를 사용하며 별도 D1, KV, R2, Queues 바인딩은 필요하지 않습니다.

## 기능

- 문서·오디오·동영상·애니메이션의 파일명에서 검색어를 생성합니다.
- 파일명을 NFC로 정규화하고 확장자와 구분자를 처리합니다.
- 기본 10자 이하는 부분 문자열·초성·자모 검색어를 생성하고, 그보다 길면 부분 문자열만 생성합니다. `FULL_MODE_THRESHOLD`로 임계값을 바꿀 수 있습니다.
- 개인 대화·그룹·채널 게시물을 처리하고 포럼 주제의 위치를 유지합니다.
- 검색어는 기존 생성 순서대로 캡션에 넣고, 넘치는 부분은 최대 2개의 답글(각 최대 4,096자)로 게시합니다. 앞에서부터 담을 수 있는 검색어까지만 반영하고 나머지는 생략합니다.
- 원본 캡션의 링크·멘션·이모지 엔티티를 보존하고, 안전하게 옮길 수 없으면 원본을 유지합니다.
- 웹훅 시크릿 검증, 중복 수신 방지, 단계별 재개, API 타임아웃 및 429 대기를 지원합니다.
- 재전송과 후속 게시가 완료되면 원본 삭제를 시도합니다. 권한 부족 시 재전송한 파일과 원본이 함께 남을 수 있습니다.

## 실행 방법

### 준비

Node.js 26(`.node-version` 참조), npm, Cloudflare 계정과 Telegram BotFather에서 발급한 봇 토큰이 필요합니다. 봇을 처리 대상 채팅에 추가하고 파일 게시 권한을 부여합니다. 그룹·채널의 원본 메시지를 삭제하려면 해당 관리자 권한도 필요합니다. 그룹의 일반 파일 메시지를 수신하려면 봇 관리자 권한 또는 BotFather의 privacy mode 설정을 확인합니다.

### 로컬 개발

```sh
npm ci
cp .dev.vars.example .dev.vars
# .dev.vars에 로컬 테스트 봇 토큰과 웹훅 시크릿 입력
npm run dev
```

### 운영 배포

Wrangler에서 Cloudflare 계정으로 인증한 뒤 운영 시크릿을 설정합니다.

```sh
npx wrangler login
```

운영에서는 `TELEGRAM_BOT_TOKEN`과 `TELEGRAM_WEBHOOK_SECRET`을 모두 Cloudflare secret으로 설정합니다. 실제 값을 명령 인자나 저장소에 적지 말고 아래 명령의 입력 프롬프트로 전달합니다.

```sh
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npm run deploy
```

### 처리할 채팅 지정

개인용이나 지정 채팅 전용으로 운영할 때는 `ALLOWED_CHAT_IDS`에 처리할 Telegram 채팅 ID를 쉼표로 구분해 지정합니다. 예를 들어 `123456789,-1001234567890`처럼 숫자 ID를 넣고 그룹·채널 ID의 음수 부호를 유지합니다. 운영에서는 `wrangler.jsonc`의 `vars`에 문자열로 설정하거나 `npx wrangler secret put ALLOWED_CHAT_IDS`를 사용합니다. 로컬에서는 `.dev.vars`에 설정합니다.

변수를 정의하지 않으면 모든 채팅을 허용합니다. 빈 문자열, 잘못된 항목, 문자열이 아닌 값은 설정 오류입니다. 설정 오류가 있으면 인증된 업데이트에 HTTP 200으로 응답하고 `Invalid ALLOWED_CHAT_IDS configuration` 오류를 Workers Logs에 남깁니다. 정상 목록에 없는 채팅에도 HTTP 200으로 응답합니다. 두 경우 모두 Durable Object 조회와 Telegram Bot API 호출을 건너뜁니다. 그룹을 사용하지 않는 개인용 또는 지정 채팅 전용 봇은 BotFather의 `/setjoingroups`로 그룹 추가를 비활성화하는 것을 권장합니다. [Telegram BotFather 설정](https://core.telegram.org/bots/features#edit-settings)

### Telegram 웹훅 등록

배포된 HTTPS 주소의 `/webhook`을 Telegram `setWebhook`에 등록하고, `secret_token`에는 Cloudflare에 저장한 것과 같은 웹훅 시크릿을 사용합니다. 아래 예시는 값을 프롬프트로 입력받습니다. 로컬 개발 서버를 Telegram과 연결하려면 외부에서 접근 가능한 HTTPS 주소가 별도로 필요합니다.

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

웹훅 주소는 `/webhook`이며 기존 `/` POST 경로도 지원합니다. 시크릿 누락·빈 값·공백 값은 HTTP 503, 헤더 누락·불일치는 401로 거부합니다. `GET /health`와 `GET /`는 프로세스 상태 확인용이며 외부 API 연결을 검증하지 않습니다.

`wrangler.jsonc`에는 `TELEGRAM_UPDATES` Durable Object 바인딩과 `v1` SQLite 클래스 마이그레이션이 포함됩니다. 이 변경을 처음 배포할 때 함께 적용해야 하며, 시크릿 설정만으로 새 코드가 동작하지는 않습니다. 이후 바인딩을 변경하면 `npm run cf-typegen`을 실행합니다.

## 웹훅 처리와 장애 복구

- 일반 텍스트, 미지원 첨부, 봇 발신 메시지, 검색어를 만들 수 없는 파일 등은 인증과 업데이트 ID 검증 후 HTTP 200을 반환합니다. 이 경로에서는 Durable Object를 호출하거나 본문을 저장하지 않습니다.
- 처리 대상 업데이트는 완료 결과 또는 수동 확인이 필요한 상태를 영속 저장한 뒤 HTTP 200을 반환합니다.
- 일시적 API 오류, 저장 오류, 작업 시간 초과 등 재시도로 진행할 수 있는 경우에는 503을 반환합니다. Telegram은 유한 횟수만 재전송하므로 실패 로그를 모니터링해야 합니다.
- 봇 ID와 `update_id`별 Durable Object에 처리에 필요한 필드(업데이트·채팅·메시지·토픽 ID, 선택된 첨부의 파일 ID와 검색어 생성에 사용할 이름, 캡션과 엔티티), 모드 임계값, 전송 진행 상태를 저장합니다. 토큰과 시크릿은 저장하지 않습니다. 동시·중복 요청은 같은 작업을 공유하며 재시도에서 확인된 전송을 건너뜁니다.
- 처리 대상 업데이트의 재시도는 최초에 저장한 처리용 데이터와 임계값을 사용합니다. 다른 봇이나 다른 업데이트는 서로 독립적으로 처리합니다.
- API 호출과 응답 본문 읽기는 최대 5초, 한 처리 시도의 API 작업 예산은 20초입니다. 예산을 소진하면 다음 웹훅 재시도에서 이어갑니다. 파일명 검색어는 캡션과 답글 2개의 최대 출력 예산까지만 순서대로 생성하며, 모든 부분 문자열을 한꺼번에 만들지 않습니다. 재시도에서도 이미 게시한 답글을 포함해 최대 2개까지만 게시합니다.
- 429의 `parameters.retry_after`는 재시도 가능 시각으로 저장합니다. 대기 중인 요청에는 API를 다시 호출하지 않고 503과 `Retry-After`를 반환합니다. 408·서버 오류 등 일시적 API 실패는 최소 1초 후 재시도할 수 있습니다. 서버는 Telegram이 `Retry-After`를 따르는지에 의존하지 않고 저장된 시각을 직접 검사합니다.
- 전송이 400·403 등 비재시도 4xx 오류(408·429 제외)로 명확하게 거부되면 실패 단계와 오류 코드를 `blockedSend`로 영속 저장하고 수동 확인 상태로 보류합니다. 저장 후 HTTP 200을 반환해 Telegram 재전송을 멈추고 수동 확인 로그를 남깁니다. 중복 요청이나 객체 재시작에도 전송·원본 삭제를 진행하지 않습니다.
- 후속 메시지가 실패하면 그 지점에서 멈추고 원본을 유지합니다. 일시적인 삭제 오류는 전송 완료 상태를 유지한 채 삭제만 재시도합니다. 삭제 권한 부족처럼 명시적인 비일시적 삭제 오류는 기존 정책대로 경고 후 완료 처리합니다.

외부 전송과 로컬 저장을 하나의 트랜잭션으로 묶을 수는 없습니다. 전송 전 `pendingSend` 의도를 저장하며, 네트워크 타임아웃·잘못된 응답·전송 결과 저장 실패로 성공 여부가 불명확해지면 **자동 재전송과 원본 삭제를 보류**합니다. `delivery_uncertain` 상태를 저장하면 HTTP 200과 `Telegram delivery requires reconciliation` 로그를 남깁니다. 저장에 실패한 요청은 503을 반환하며, 다음 요청에서 확인된 전송 의도를 바탕으로 보류 상태를 기록합니다.

운영자는 로그의 `update_id`로 해당 채팅의 게시 상태를 확인해야 합니다. 웹훅 요청만 반복해서는 이 보류를 해제하지 않습니다. 자동 복구 가능한 429·일시적 API 오류와 구분하고, Telegram에서 전송 결과와 권한·요청 오류를 확인한 뒤 보존된 원본을 이용해 수동으로 처리를 마무리하거나 새 업로드로 다시 처리합니다. 별도의 공개 관리·보류 해제 엔드포인트는 제공하지 않습니다.

처리가 완료되면 Durable Object의 활성 기록을 처리 결과로 덮어쓰고, 중복 방지를 위해 완료 후 7일간 보존합니다. 미완료 기록은 첫 실패 후 60일이 지나면 만료됩니다. 알람이 실행되거나 만료 후 웹훅이 들어오면 본문과 진행 상태를 지우고 `expired_update` 결과만 7일간 보존합니다. 같은 업데이트가 이 기간에 다시 들어오면 Telegram API 호출 없이 HTTP 200을 반환합니다. 실패를 기록하기 전에 중단된 작업은 최초 처리 시점이 기준이며, 이후 재시도로 보존 기간이 늘어나지 않습니다. 만료 시각이 없는 이전 버전의 미완료 기록은 대상 업데이트가 다시 처리되거나 기존 알람이 실행된 시점부터 60일을 계산합니다. 새 요청이나 알람이 없는 이전 기록에는 이 정책이 소급 적용되지 않습니다.

## 원본 캡션과 링크 보존

원본 캡션의 공백·줄바꿈·유니코드 표현을 그대로 유지하고 뒤에 검색어를 추가합니다. `caption_entities`도 링크 URL, 멘션 사용자, 사용자 정의 이모지 ID, 언어 등의 메타데이터와 함께 전달합니다. 캡션 앞부분을 변경하지 않으므로 Telegram의 UTF-16 엔티티 오프셋을 이동하거나 다시 계산하지 않습니다. 검색어에는 `parse_mode`를 적용하지 않습니다.

원본 캡션이 1,024자이면 캡션은 그대로 재전송하고 검색어는 답글로 보냅니다. 원본 캡션이 그보다 길거나 엔티티 범위를 안전하게 보존할 수 없으면 **파일과 캡션을 원본 위치에 유지하고 검색어만 원본의 답글로 게시**합니다. 설명의 나머지를 잘라 버리거나 엔티티를 버리고 원본을 삭제하지 않습니다. 이 경로도 후속 메시지별 진행 상태를 저장하므로 재시도에서 확인된 전송을 반복하지 않습니다.

엔티티를 포함한 재전송이 Telegram에서 거부되면 원본을 삭제하지 않습니다. 이전 캡션 처리 정책으로 재전송된 미완료 작업은 새 코드가 메타데이터 보존 여부를 확인할 수 없으므로 `caption_preservation_unverified`로 보류합니다. 이 경우도 원본을 유지하고 운영자 확인 후 처리해야 합니다. 이미 완료된 이전 작업의 기록은 기존 중복 방지 정책을 따릅니다.

## 검증

```sh
npm run format:check
npm run typecheck
npm run test:ci
```

회귀 테스트는 실제 Workers/Durable Objects 로컬 런타임을 사용하며 Telegram API 호출은 모의 처리합니다. 웹훅 인증, 채팅 허용 목록, 응답 전 영속 저장, 429 대기, 부분 전송 재개, 중복 수신, 객체 재시작, 미완료 기록 만료, API 타임아웃, 캡션·엔티티 보존과 긴 캡션의 원본 유지 경로를 검증합니다.

공식 문서: [Telegram 웹훅](https://core.telegram.org/bots/api#setwebhook), [Telegram 오류 매개변수](https://core.telegram.org/bots/api#responseparameters), [Durable Objects](https://developers.cloudflare.com/durable-objects/), [Durable Object alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).

## 기여와 보안

커밋 메시지와 변경 요청 제목은 Conventional Commits 형식을 따르며 설명은 한국어를 우선합니다. 개발·검증·병합 절차는 [기여 안내](CONTRIBUTING.md), 취약점 비공개 제보는 [보안 정책](SECURITY.md)을 참고하세요.

## 라이선스

Copyright 2026 mksdr.

이 프로젝트는 [Apache License 2.0](LICENSE)을 따릅니다. 전체 조건은 저장소의 `LICENSE` 파일을 참고하세요.
