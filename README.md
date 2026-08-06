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
- Gemini가 대표사진·공연사진·선택한 PDF 페이지를 직접 보고 이미지의 역할, 페이지 서사, 제목과 레이아웃을 설계하는 AI PPTX 생성
- 같은 이미지를 반복하지 않고 표지·소개·현장 갤러리·경력·연락 목적에 맞게 원본 사진을 배치
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

## AI API 연결

무료 테스트에는 Gemini API를 우선 사용합니다. Gemini 키가 있으면 Gemini로 분석하고, 없거나 호출에 실패하면 OpenAI 키를 대체 경로로 사용합니다. 둘 다 없거나 실패해도 OCR·규칙 기반 분석은 계속 동작합니다.

1. [Google AI Studio](https://aistudio.google.com/apikey)에서 Gemini API 키를 만듭니다.
2. 프로젝트 루트에서 환경 파일을 만듭니다.

```powershell
Copy-Item .env.example .env.local
notepad .env.local
```

3. `.env.local`에 아래 값을 입력합니다. 키에는 절대 `NEXT_PUBLIC_` 접두사를 붙이지 마세요.

```dotenv
GEMINI_API_KEY=발급받은_키
GEMINI_MODEL=gemini-3.6-flash
```

4. 이미 개발 서버가 실행 중이었다면 종료 후 `npm run dev`로 다시 시작합니다.

OpenAI를 유료 대체 경로로 함께 사용하려면 같은 파일에 `OPENAI_API_KEY`와 `OPENAI_MODEL`을 추가할 수 있습니다. 키가 없거나 AI 호출이 실패해도 앱은 OCR과 확장된 규칙 기반 분석으로 계속 동작합니다.

### Vercel 배포 시

Vercel 프로젝트의 **Settings → Environment Variables**에 `GEMINI_API_KEY`와 `GEMINI_MODEL`을 추가한 뒤 다시 배포합니다. 환경변수는 Production, Preview, Development 중 사용할 환경에 각각 적용하세요. 비밀키를 GitHub, 클라이언트 코드, 브라우저 콘솔에 넣으면 안 됩니다.

### AI 분석 흐름

PDF 업로드 후 앱은 먼저 모든 페이지를 렌더링하고 텍스트 레이어가 부족한 페이지에 한글·영문 OCR을 실행합니다. Gemini에는 OCR 요약본만 보내지 않고 원본 PDF 전체를 직접 전달해 텍스트, 이미지, 표와 페이지 배치를 함께 분석하며, 구조화된 결과로 연혁·공연·수상·언론을 분류합니다. 분석 화면에는 실제 사용 중인 AI 제공자와 모델이 표시됩니다. Gemini가 실패하고 OpenAI 키가 있으면 OpenAI로 자동 재시도합니다. AI 결과도 자동 확정하지 않으며 사용자가 수정하거나 제외한 뒤 프로필에 반영할 수 있습니다.

디자인 다음 단계에서 Gemini가 업로드된 이미지 썸네일, 사용자가 입력한 정보, 제외하지 않은 PDF 추출 항목과 페이지 OCR 원문을 함께 보고 섭외 담당자를 위한 이야기 흐름을 정합니다. 수상·공연·언론·주요 경력은 하나의 근거 목록으로 합쳐 중복을 제거하고, 모든 근거가 PPT에 들어갔는지 품질 검사로 확인합니다. 자료가 많으면 선택한 페이지 수보다 자동으로 늘려 한 페이지에 억지로 압축하지 않습니다. 각 슬라이드 유형에는 제목·본문·불릿 글자 예산이 있어 내용이 길어지면 글자를 줄이는 대신 핵심만 남깁니다. 사진과 PDF 페이지는 원본 비율을 유지한 채 슬라이드 프레임 안에 배치합니다. 최종 화면과 다운로드되는 PPTX는 동일한 기획·문구·사진을 사용합니다. AI를 사용할 수 없을 때만 동일한 자산을 활용하는 기본 기획으로 대체합니다.

### 웹에서 아티스트 사진 찾기

대표사진과 아티스트명이 등록되면 디자인 단계에서 네이버·Google·YouTube의 이미지 후보를 검색할 수 있습니다. Gemini는 얼굴 생체인증으로 동일인을 확정하지 않고 검색 제목·출처의 이름 일치, 개인/단체 구성, 활동 분야, 무대 맥락, 해상도와 구도를 평가합니다. 검색 사진은 출처 링크와 점수를 보여준 뒤 사용자가 확인한 것만 PPT 자산에 추가되며, PPT 발표자 노트에도 원본 출처가 기록됩니다.

- 네이버: `NAVER_CLIENT_ID`, `NAVER_CLIENT_SECRET`
- Google 이미지 검색: `GOOGLE_SEARCH_API_KEY`, `GOOGLE_SEARCH_ENGINE_ID`
- YouTube: `YOUTUBE_API_KEY`

로컬에서는 `.env.local`, Vercel에서는 Project Settings → Environment Variables에 사용할 검색원의 키를 추가하고 재배포합니다. 모든 검색원을 한꺼번에 설정할 필요는 없습니다.

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
