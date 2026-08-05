# Artfolio Studio

문화예술인이 보유한 자료에 따라 제작 경로를 나누고, 입력 내용과 선택한 디자인으로 편집 가능한 PPTX 프로필을 만드는 Next.js 애플리케이션입니다.

## 구현 기능

- PDF 보유 / 미보유 / 잘 모르겠음 3-way 분기
- 30MB 제한, 드래그앤드롭과 진행 상태가 포함된 PDF 업로드
- PDF 텍스트 추출 및 항목별 신뢰도·검토·수정·제외
- 선택형 질문, 기본 정보, 경력 입력
- 입력한 사실만 사용하는 프로필 문구 생성
- 대표·공연 사진 업로드와 브라우저 초안 자동 저장
- 4종 디자인 템플릿과 관리자 활성화 화면
- 실제 미리보기와 편집 가능한 PPTX 다운로드
- 모바일 반응형 UI

## 실행

```bash
npm install
npm run dev
```

브라우저에서 `http://localhost:3000`을 엽니다. 관리자 화면은 `/admin/design-templates`입니다.

## AI 연결 (선택)

`.env.example`을 `.env.local`로 복사하고 `OPENAI_API_KEY`를 설정합니다. 키가 없거나 호출에 실패하면 앱은 입력된 정보만 조합하는 규칙 기반 생성기를 자동으로 사용합니다.

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
