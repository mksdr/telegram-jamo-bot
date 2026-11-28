# 텔레그램 한글 자모 봇

[![GitHub License](https://img.shields.io/github/license/mksdr/telegram-jamo-bot)](LICENSE)
[![GitHub Actions Workflow Status](https://img.shields.io/github/actions/workflow/status/mksdr/telegram-jamo-bot/ci.yml)](https://github.com/mksdr/telegram-jamo-bot/actions/workflows/ci.yml)
![GitHub repo size](https://img.shields.io/github/repo-size/mksdr/telegram-jamo-bot)

텔레그램에 올린 파일을 파일명의 일부, 초성, 자모로 찾을 수 있게 해 주는 봇입니다. 예를 들어 `한국.pdf`를 올리면 `한국`, `ㅎㄱ`, `ㅎㅏㄴㄱㅜㄱ` 같은 검색어를 캡션이나 답글에 게시합니다. 봇은 Cloudflare Workers에서 실행됩니다.

문서, 오디오, 동영상, 애니메이션을 처리합니다. 보통 파일을 검색어와 함께 다시 보내고, 필요한 답글을 모두 게시한 뒤 원본 삭제를 시도합니다. 원본 캡션을 안전하게 옮길 수 없으면 파일은 그대로 두고 검색어만 답글로 게시합니다. 재전송할 때는 앨범 묶음, 미디어 스포일러, 캡션 표시 위치가 달라질 수 있습니다. [지원 범위와 제약](docs/usage.md#지원-범위와-제약)

## 문서

- [사용법](docs/usage.md)에서 검색어가 만들어지는 방식과 파일을 올렸을 때의 동작을 확인하세요.
- [배포와 설정](docs/deployment.md)에서 로컬 실행, 채팅 권한, Cloudflare 배포와 Telegram 웹훅 등록을 안내합니다.
- [운영과 장애 대응](docs/operations.md)에서 재시도, 수동 확인, 데이터 보존 정책을 확인하세요.
- [기여 안내](CONTRIBUTING.md)에는 개발과 검증 절차가, [보안 정책](SECURITY.md)에는 비공개 취약점 제보 절차가 있습니다.

## 라이선스

Copyright 2026 mksdr. [Apache License 2.0](LICENSE)
