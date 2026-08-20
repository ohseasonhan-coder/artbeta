"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { defaultSiteConfig, mergeSiteConfig, SiteConfig } from "@/types/site-config";

export const SITE_CONFIG_STORAGE_KEY = "artfolio-site-config";
const SiteSettingsContext = createContext<{ config: SiteConfig; setPreview: (config: SiteConfig) => void }>({ config: defaultSiteConfig, setPreview: () => undefined });

export function SiteSettingsProvider({ children }: { children: React.ReactNode }) {
  const [config, setConfig] = useState(defaultSiteConfig);
  useEffect(() => {
    const local = localStorage.getItem(SITE_CONFIG_STORAGE_KEY);
    let hasLocalDraft = false;
    if (local) {
      try { setConfig(mergeSiteConfig(JSON.parse(local))); hasLocalDraft = true; } catch { /* 기본 설정 유지 */ }
    }
    void fetch("/api/site-settings", { cache: "no-store" }).then((response) => response.json()).then((result) => {
      if (!hasLocalDraft && result.storage === "shared" && result.config) setConfig(mergeSiteConfig(result.config));
    }).catch(() => undefined);
  }, []);
  const style = useMemo(() => ({
    "--green": config.theme.primary, "--lime": config.theme.accent, "--ink": config.theme.ink,
    "--paper": config.theme.paper, "--white": config.theme.surface, "--admin-radius": `${config.theme.radius}px`,
    "--site-content-width": `${config.theme.contentWidth}px`, "--site-font-scale": `${config.theme.fontScale / 100}`,
  } as React.CSSProperties), [config]);
  return <SiteSettingsContext.Provider value={{ config, setPreview: setConfig }}><div className={`site-runtime header-${config.theme.headerStyle}`} style={style}>{children}</div></SiteSettingsContext.Provider>;
}

export function useSiteSettings() { return useContext(SiteSettingsContext); }
