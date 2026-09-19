# 위시태그 (Wishtag)

생일 위시리스트 페이지예요. 친구들이 항목을 **선점**해서 선물이 겹치지 않게 해줘요.

- 페이지: https://minim0.github.io/wishtag/
- 프론트엔드: GitHub Pages에 올린 정적 파일(`index.html`, `style.css`, `app.js`). 빌드 과정 없음
- 백엔드: Google Apps Script 웹 앱(URL은 `app.js`의 `API`). 데이터는 ScriptProperties에 저장됨

## 알아둘 것

- 백엔드와는 **JSONP로만** 통신해요. `fetch`로 바꾸면 CORS 때문에 동작하지 않아요.
- Apps Script는 약 8KB가 넘는 GET 요청을 거절해요. 그래서 `app.js`의 `MAX_URL`에서 요청 길이를 미리 막아둬요.
- PIN과 선점 암호는 SHA-256 해시로만 보내요. `crypto.subtle`은 https나 `localhost`에서만 동작해요. `file://`로 열면 안 돼요.

## 로컬에서 실행

```bash
python -m http.server 8770
```

실행한 뒤 http://localhost:8770 을 열면 돼요. 로컬에서도 실제 서버 데이터를 쓰니까 선점이나 관리자 기능은 조심해서 테스트하세요.

## Apps Script를 고칠 때

"새 배포"를 누르면 URL이 바뀌어요. 아래 순서로 배포하세요.

1. 코드 수정 후 저장
2. **배포 → 배포 관리**
3. 기존 배포 옆 연필 아이콘 → 버전에서 **새 버전** 선택
4. 배포

접근 설정은 "다음 사용자 인증 정보로 실행: 나", "액세스 권한이 있는 사용자: 모든 사용자"로 둬야 해요.
