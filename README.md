# Artfolio Studio

문화예술인이 보유한 자료에 따라 제작 경로를 나누고, 입력 내용과 선택한 디자인으로 편집 가능한 PPTX 프로필을 만드는 Next.js 애플리케이션입니다.

## 구현 기능

- PDF 보유 / 미보유 / 잘 모르겠음 3-way 분기
- 30MB 제한, 드래그앤드롭과 진행 상태가 포함된 PDF 업로드
- 일반 PDF 텍스트 추출과 이미지형 PDF 한글·영문 OCR
- OpenAI 멀티모달 분석: PDF 원문과 페이지 이미지를 함께 읽어 활동명·분야·소개·연혁·공연·수상·언론·연락처를 구조화
- 날짜별 활동을 최대한 누락 없이 추출하고 근거 페이지와 신뢰도를 표시
- 전체 PDF 페이지 이미지 보존, OCR 신뢰도 표시 및 프로필 자산 재사용
- 추출 항목별 신뢰도·검토·수정·제외
- 선택형 질문, 기본 정보, 경력 입력
- 입력한 사실만 사용하는 프로필 문구 생성
- 대표·공연 사진 업로드와 대용량 이미지가 가능한 IndexedDB 초안 자동 저장
- 4종 디자인 템플릿과 관리자 활성화 화면
- 실제 미리보기와 편집 가능한 PPTX 다운로드
- 모바일 반응형 UI

## 실행

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:3000`을 엽니다. 관리자 화면은 `/admin/design-templates`입니다.

## OpenAI API 연결

1. [OpenAI API 키 페이지](https://platform.openai.com/api-keys)에서 비밀키를 만듭니다. ChatGPT 구독과 API 사용 요금은 별도이므로 API 프로젝트에 결제 수단 또는 크레딧도 설정해야 합니다.
2. 프로젝트 루트에서 환경 파일을 만듭니다.

```powershell
Copy-Item .env.example .env.local
notepad .env.local
```

3. `.env.local`에 아래 값을 입력합니다. 키에는 절대 `NEXT_PUBLIC_` 접두사를 붙이지 마세요.

```dotenv
OPENAI_API_KEY=sk-proj-발급받은_키
OPENAI_MODEL=gpt-5.6-sol
```

4. 이미 개발 서버가 실행 중이었다면 종료 후 `npm run dev`로 다시 시작합니다.

`gpt-5.6-sol`은 정밀 추출 품질을 우선한 기본값입니다. 속도와 비용의 균형이 중요하면 `OPENAI_MODEL=gpt-5.6-terra`로 변경할 수 있습니다. 키가 없거나 AI 호출이 실패해도 앱은 OCR과 확장된 규칙 기반 분석으로 계속 동작합니다.

### Vercel 배포 시

Vercel 프로젝트의 **Settings → Environment Variables**에 `OPENAI_API_KEY`와 `OPENAI_MODEL`을 추가한 뒤 다시 배포합니다. 환경변수는 Production, Preview, Development 중 사용할 환경에 각각 적용하세요. 비밀키를 GitHub, 클라이언트 코드, 브라우저 콘솔에 넣으면 안 됩니다.

### AI 분석 흐름

PDF 업로드 후 앱은 먼저 모든 페이지를 렌더링하고 텍스트 레이어가 부족한 페이지에 한글·영문 OCR을 실행합니다. 그다음 전체 추출 원문과 최대 10개 페이지 이미지를 OpenAI Responses API에 함께 보내고, 구조화된 결과로 연혁·공연·수상·언론을 분류합니다. AI 결과도 자동 확정하지 않으며 사용자가 수정하거나 제외한 뒤 프로필에 반영할 수 있습니다.

## 자산 저장 원칙

대용량 PDF, 사용자 사진, 생성된 PPTX/PDF, 원본 디자인 이미지는 Git에 포함하지 않습니다. 실제 운영에서는 아래 버킷을 분리해 외부 스토리지에 저장합니다.

```text
design-assets/templates/{template_key}/
artist-assets/{user_id}/profile-pdfs|representative-images|performance-images/
profile-exports/{user_id}/{profile_project_id}/pptx|pdf|previews|versions/
```

저장소에는 템플릿 레지스트리, 레이아웃 정의, 경로와 manifest만 유지합니다.

## 운영 전 추가 권장 사항

- Supabase 인증·데이터베이스·스토리지 연결
- 이미지형 PDF OCR 파이프라인
- 서버 측 PPTX 생성 및 버전 보관
- 관리자 권한 보호와 업로드 파일 악성 코드 검사
- Vercel Blob 또는 S3 호환 스토리지 연결
- 대규모 문서용 OCR 작업 큐와 진행률 스트리밍
