"use client";

import Link from "next/link";

import { PageIntro } from "./page-intro";
import { Surface } from "./surface";

export function ProjectsPanel() {
  return (
    <>
      {/* Topbar with sidebar toggle */}
      <div className="topbar">
        <button
          type="button"
          className="icon-btn"
          onClick={() => window.dispatchEvent(new CustomEvent('toggleSidebar'))}
          aria-label="Toggle sidebar"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="3" y1="12" x2="21" y2="12"></line>
            <line x1="3" y1="6" x2="21" y2="6"></line>
            <line x1="3" y1="18" x2="21" y2="18"></line>
          </svg>
        </button>
        <span className="topbar-title">Projects</span>
        <div className="topbar-spacer" />
      </div>

      <PageIntro
        eyebrow="Projects"
        title="Prepare for inspectable orchestration flows"
        description="Projects become the container for routed work, audit loops, and future task history."
        actions={
          <div className="button-row">
            <Link className="button primary" href="/chat">
              Start in chat
            </Link>
          </div>
        }
      />

      <section className="two-up">
        <Surface>
          <p className="section-label">Planned workflow</p>
          <div className="stack-list">
            <div className="stack-item">
              <span>1</span>
              <p>Router decides the best execution path.</p>
            </div>
            <div className="stack-item">
              <span>2</span>
              <p>Planner breaks work into explicit checkpoints.</p>
            </div>
            <div className="stack-item">
              <span>3</span>
              <p>Coder implements while Auditor and Assistant keep the flow inspectable.</p>
            </div>
          </div>
        </Surface>
        <Surface>
          <p className="section-label">Current state</p>
          <h3>Foundation ready</h3>
          <p className="page-copy">
            Provider registry, role assignments, settings, and component-aware chat are live.
            Orchestration history is the next expansion point.
          </p>
        </Surface>
      </section>
    </>
  );
}
