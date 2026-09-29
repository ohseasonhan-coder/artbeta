"use client";

import { useEffect, useState } from "react";
import type { SlideScene } from "./pptx/slide-scene";
import { SLIDE_HEIGHT, SLIDE_WIDTH } from "./pptx/slide-scene";

export default function SlidePreview({ scene }: { scene: SlideScene }) {
  return <div className="scene-preview" style={{ background: scene.background }} role="group" aria-label="포트폴리오 슬라이드">
    {scene.nodes.map((node, index) => {
      const frame = { left: `${node.x / SLIDE_WIDTH * 100}%`, top: `${node.y / SLIDE_HEIGHT * 100}%`, width: `${node.w / SLIDE_WIDTH * 100}%`, height: `${node.h / SLIDE_HEIGHT * 100}%` };
      if (node.type === "rect") return <div key={index} className="scene-shape" aria-hidden="true" style={{ ...frame, background: node.color }} />;
      if (node.type === "image") return <SceneImage key={`${index}:${node.asset.dataUrl.slice(-40)}`} src={node.asset.dataUrl} alt={node.asset.sourceTitle || "포트폴리오 사진"} style={frame} />;
      const style = { ...frame, fontFamily: `"${node.fontFace}", "Noto Sans KR", sans-serif`, fontSize: `${node.fontSize / (SLIDE_WIDTH * 72) * 100}cqw`, fontWeight: node.bold ? 700 : 400, color: node.color };
      return node.href ? <a className="scene-text" key={index} style={style} href={node.href} target="_blank" rel="noreferrer" title={node.original}>{node.text}</a> : <div className="scene-text" key={index} style={style} title={node.truncated ? node.original : undefined}>{node.text}</div>;
    })}
  </div>;
}

function SceneImage({ src, alt, style }: { src: string; alt: string; style: React.CSSProperties }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  return failed ? <div className="scene-image-error" style={style}>사진을 불러오지 못했습니다</div> : <img className="scene-image" style={style} src={src} alt={alt} onError={() => setFailed(true)} />;
}
