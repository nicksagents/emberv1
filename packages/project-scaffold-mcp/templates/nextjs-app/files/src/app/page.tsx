export default function HomePage() {
  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">Ember Scaffold</p>
        <h1>{{app_title}}</h1>
        <p className="lede">
          This project was scaffolded for fast iteration. Replace this landing page
          with the requested feature flow, keep App Router conventions, and let the
          director role handle the real product implementation.
        </p>
      </section>

      <section className="grid">
        <article>
          <h2>Suggested first slice</h2>
          <p>Build a real page in <code>src/app/page.tsx</code> or split routes under <code>src/app/</code>.</p>
        </article>
        <article>
          <h2>Agent conventions</h2>
          <p>Read <code>AGENTS.md</code> and <code>.ember/skills/project-stack/SKILL.md</code> before broad changes.</p>
        </article>
      </section>
    </main>
  );
}
