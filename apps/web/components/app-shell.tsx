"use client";

import type { ReactNode } from "react";
import { Suspense, useCallback, useEffect, useState } from "react";

import { ShellNav } from "./shell-nav";

export function AppShell({ children }: { children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(min-width: 1024px)");
    const syncSidebar = (event?: MediaQueryListEvent) => {
      const matches = event ? event.matches : media.matches;
      setIsMobile(!matches);
      if (!event) {
        setSidebarOpen(matches);
      }
    };

    syncSidebar();
    media.addEventListener("change", syncSidebar);
    return () => media.removeEventListener("change", syncSidebar);
  }, []);

  useEffect(() => {
    const handleToggle = () => {
      setSidebarOpen((current) => !current);
    };

    window.addEventListener("toggleSidebar", handleToggle);
    return () => window.removeEventListener("toggleSidebar", handleToggle);
  }, []);

  const handleCloseSidebar = useCallback(() => {
    setSidebarOpen(false);
  }, []);

  return (
    <div className={`app-frame ${sidebarOpen ? "sidebar-open" : "sidebar-closed"}`}>
      {isMobile && sidebarOpen ? (
        <div className="sidebar-backdrop open" onClick={handleCloseSidebar} />
      ) : null}
      <Suspense fallback={null}>
        <ShellNav
          isOpen={sidebarOpen}
          onToggle={() => setSidebarOpen((current) => !current)}
          onClose={handleCloseSidebar}
        />
      </Suspense>
      <div className="content-frame">{children}</div>
    </div>
  );
}
