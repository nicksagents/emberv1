import Link from "next/link";

import type {
  Provider,
  RoleAssignment,
  RuntimeState,
  Settings,
} from "@ember/core/client";

import { PageIntro } from "./page-intro";
import { Surface } from "./surface";

export function DashboardOverview({
  runtime,
  providers,
  assignments,
  settings,
}: {
  runtime: RuntimeState;
  providers: Provider[];
  assignments: RoleAssignment[];
  settings: Settings;
}) {
  const connected = providers.filter((provider) => provider.status === "connected").length;
  const assigned = assignments.filter((assignment) => assignment.providerId).length;

  return (
    <>
      <PageIntro
        eyebrow="Start here"
        title="Set up EMBER in three steps"
        description="Connect a provider, assign it to a role, then open chat."
        actions={
          <div className="button-row">
            <Link className="button" href="/providers/new">
              Add provider
            </Link>
            <Link className="button primary" href="/chat">
              Open chat
            </Link>
          </div>
        }
      />

      <section className="two-up">
        <Surface>
          <p className="section-label">Quick setup</p>
          <div className="stack-list">
            <div className="stack-item">
              <span>1</span>
              <p>Go to Providers and connect Codex, Claude, Anthropic, or a local model endpoint.</p>
            </div>
            <div className="stack-item">
              <span>2</span>
              <p>Go to Roles and assign one provider and one model to the role you want to use.</p>
            </div>
            <div className="stack-item">
              <span>3</span>
              <p>Go to Chat and send one message. EMBER will tell you if it used live execution or fallback.</p>
            </div>
          </div>
        </Surface>
        <Surface>
          <p className="section-label">Status</p>
          <dl className="detail-list">
            <div>
              <dt>Runtime</dt>
              <dd>{runtime.status}</dd>
            </div>
            <div>
              <dt>Connected providers</dt>
              <dd>{connected} of {providers.length}</dd>
            </div>
            <div>
              <dt>Assigned roles</dt>
              <dd>{assigned} of 6</dd>
            </div>
            <div>
              <dt>Operator</dt>
              <dd>{settings.humanName}</dd>
            </div>
          </dl>
        </Surface>
      </section>
    </>
  );
}
