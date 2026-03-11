const cards = [
  "Convert this shell into the product surface the user actually asked for.",
  "Promote real data flow and routes once the feature slice is clear.",
  "Use AGENTS.md and the local skill before adding new framework layers.",
];

export default function App() {
  return (
    <div className="frame">
      <header className="masthead">
        <p>Ember Scaffold</p>
        <h1>{{app_title}}</h1>
        <span>React + Vite starter</span>
      </header>
      <main className="cards">
        {cards.map((card) => (
          <article key={card}>
            <p>{card}</p>
          </article>
        ))}
      </main>
    </div>
  );
}
