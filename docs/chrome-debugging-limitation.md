# Chrome 디버그 포트 제약사항

## 왜 기존 Chrome에 직접 붙을 수 없는가?

### 핵심 제약: Chrome DevTools Protocol (CDP)

외부 도구(VSCode, Playwright, Puppeteer 등)가 Chrome을 제어하려면 **Chrome DevTools Protocol (CDP)** 을 사용해야 합니다. CDP는 WebSocket으로 통신하며, Chrome이 **`--remote-debugging-port=<port>`** 플래그로 시작되어야만 이 WebSocket 엔드포인트가 열립니다.

```
일반 Chrome 실행: CDP 엔드포인트 없음 → 외부 도구 연결 불가
디버그 Chrome 실행: ws://127.0.0.1:9222/... → 연결 가능
```

이것은 **Chrome의 보안 정책**입니다. 아무 웹페이지나 로컬 프로세스가 사용자의 브라우저 세션을 제어할 수 없도록, CDP 접근은 명시적 opt-in으로만 허용됩니다.

### 왜 실행 중인 Chrome에 디버그 포트를 추가할 수 없는가?

- `--remote-debugging-port`는 Chrome **시작 시에만** 적용됩니다
- 실행 중인 Chrome 프로세스에 나중에 디버그 포트를 활성화하는 API는 없습니다
- 이것도 보안상 의도된 설계입니다 — 악성 프로그램이 이미 실행 중인 Chrome에 접근하는 것을 방지

### 왜 기본 프로필로는 `--remote-debugging-port`가 안 되는가?

Chrome은 `--remote-debugging-port`를 사용할 때 **기본(default) 프로필 디렉토리를 거부**합니다:

```
DevTools remote debugging requires a non-default data directory.
Specify this using --user-data-dir.
```

이 제약은 Chrome 보안 강화의 일부로, 사용자의 기본 프로필(쿠키, 비밀번호, 세션 등)이 디버그 포트를 통해 노출되는 것을 방지합니다.

### 왜 기존 Chrome을 재시작하는 방식도 안 되는가?

macOS에서 시도하면 여러 문제가 발생합니다:

1. **프로세스 합류 문제**: Chrome 프로세스가 하나라도 남아있으면, 새로 실행한 Chrome이 기존 인스턴스에 "합류"하면서 `--remote-debugging-port` 플래그가 무시됩니다

2. **강제 종료 시 crash recovery**: `kill -9`로 Chrome을 강제 종료하면 Chrome이 "crash recovery" 모드로 재시작되면서 디버그 포트를 바인딩하지 않는 경우가 있습니다

3. **기본 프로필 제약**: 위에서 설명한 대로, 기본 프로필로는 디버그 포트 자체가 거부됩니다

## 해결 방법: 별도 디버그 Chrome 인스턴스

이 확장은 **별도의 Chrome 인스턴스**를 사용합니다:

```
일반 Chrome  → ~/Library/Application Support/Google/Chrome/     (디버그 포트 없음)
디버그 Chrome → ~/Library/Application Support/Google/Chrome-Debug/ (디버그 포트 있음)
```

### 장점

- 기존 Chrome을 건드리지 않음 — 탭, 세션, 로그인 상태 유지
- 디버그 Chrome은 재사용 가능 — 세션 종료 후에도 살아있음
- 다음 디버그 세션에서 이미 떠있는 디버그 Chrome을 자동으로 재사용
- 두 Chrome이 동시에 실행 가능

### 단점

- 디버그 Chrome은 별도 프로필이므로 로그인 상태가 없음
- 처음 실행 시 새 Chrome 창이 뜸 (이후에는 재사용)

### 다른 도구들은 어떻게 하는가?

| 도구 | 접근 방식 |
|------|-----------|
| VSCode JS Debugger | 별도 Chrome 인스턴스 (temp profile) |
| Playwright | 별도 Chromium 인스턴스 (temp profile) |
| Puppeteer | 별도 Chromium 인스턴스 (temp profile) |
| Chrome DevTools | Chrome 내장이므로 제약 없음 |

모든 외부 디버깅 도구가 동일한 제약으로 인해 별도 인스턴스를 사용합니다.

## 대안: 항상 디버그 포트로 Chrome 시작하기

macOS에서 Chrome을 항상 디버그 포트와 함께 시작하려면:

```bash
# Chrome alias 설정 (~/.zshrc에 추가)
alias chrome='open -a "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/Library/Application Support/Google/Chrome-Debug"'
```

또는 macOS Automator로 별도 앱을 만들 수 있습니다.
