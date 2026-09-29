import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createCanvas } from "@napi-rs/canvas";
const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url), cache = new Map();
function load(filename) {
  if (cache.has(filename)) return cache.get(filename).exports;
  const module = { exports: {} }; cache.set(filename, module);
  const code = ts.transpileModule(readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const localRequire = name => name.startsWith("@/") ? load(resolve(root, "src", name.slice(2)) + ".ts") : name.startsWith(".") ? load(resolve(dirname(filename), name) + ".ts") : require(name);
  new Function("require", "module", "exports", code)(localRequire, module, module.exports);
  return module.exports;
}
const { buildSlideScene, containImage, inspectSlideScene, SLIDE_WIDTH, SLIDE_HEIGHT } = load(resolve(root, "src/features/profile-export/pptx/slide-scene.ts"));
const { initialProfile } = load(resolve(root, "src/types/profile.ts"));
const { designTemplates } = load(resolve(root, "src/features/design-templates/registry/templates.ts"));

const profile = {...initialProfile, artistName: "아티스트 포트폴리오", primaryField: "클래식 · 크로스오버", contact: "booking@example.com"};
const base = {eyebrow: "", body: "", bullets: [], imageRefs: [], careerIndexes: [], layout: "editorial"};
const slides = [
 {...base,type:"cover",title:"아티스트 포트폴리오",body:"무대의 성격에 맞춰 선택하는 공연",eyebrow:"PORTFOLIO / DESIGN SAMPLE"},
 {...base,type:"strengths",title:"공연 제안",bullets:["제안 적합성 · 행사 목적과 관객에 맞는 공연", "대표 이력 · 실제 공연과 수상 이력을 제시", "운영 조건 · 확정된 공연 시간과 출연 인원"]},
 {...base,type:"program",title:"공연 프로그램",bullets:["클래식 레퍼토리", "뮤지컬 넘버", "영화 음악", "크로스오버", "한국 가곡", "앙코르"]},
 {...base,type:"contact",title:"다음 무대를 함께 준비합니다",body:"공연 일정과 출연 조건을 문의해 주세요"}
];
mkdirSync(resolve(root,"tmp/layout-review"),{recursive:true});
const montage=createCanvas(1600,900), mc=montage.getContext("2d");
for(const [i,slide] of slides.entries()){
 const scene=buildSlideScene(slide,i,profile,designTemplates[0],new Map());
 if(inspectSlideScene(scene).length) throw Error(inspectSlideScene(scene).join("\n"));
 const canvas=createCanvas(1600,900),ctx=canvas.getContext("2d"),unit=120;
 ctx.fillStyle=scene.background;ctx.fillRect(0,0,1600,900);
 for(const n of scene.nodes){
  if(n.type==="rect"){ctx.fillStyle=n.color;ctx.fillRect(n.x*unit,n.y*unit,n.w*unit,n.h*unit);}
  if(n.type==="text"){const size=n.fontSize/72*unit;ctx.font=`${n.bold?700:400} ${size}px "${n.fontFace}"`;ctx.fillStyle=n.color;ctx.textBaseline="top";n.text.split("\n").forEach((line,row)=>ctx.fillText(line,n.x*unit,n.y*unit+row*size*1.24));}
 }
 writeFileSync(resolve(root,`tmp/layout-review/slide-${i+1}.png`),canvas.toBuffer("image/png"));
 mc.drawImage(canvas,(i%2)*800,Math.floor(i/2)*450,800,450);
}
writeFileSync(resolve(root,"tmp/layout-review/layouts.png"),montage.toBuffer("image/png"));
console.log("Rendered four typography layout samples; fictional copy for visual QA only.");
