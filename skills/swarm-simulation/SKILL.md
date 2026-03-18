---
name: swarm-simulation
description: Multi-perspective scenario simulation using diverse AI personas
roles: [coordinator, advisor, director, inspector]
tools: [swarm_simulate, swarm_interview, swarm_report]
---

# Swarm Simulation

Fan out multiple small-model personas to simulate scenarios from diverse perspectives, debate across rounds, and synthesize probability assessments.

## When to Use

- Predicting outcomes of complex scenarios (markets, geopolitics, business decisions)
- Exploring a decision from multiple expert perspectives before committing
- Stress-testing assumptions by having contrarian personas challenge them
- Generating probability distributions for uncertain outcomes
- Any question of the form "What are the odds of X?" or "What would happen if Y?"

## Workflow

### 1. Create & Run a Simulation (single call)
```
swarm_simulate action=create scenario="..." domain=finance persona_count=8 round_count=3
```

This creates AND automatically runs the full simulation — persona generation, all rounds, and final synthesis — in one tool call. No separate `run` call needed.

Choose domain from: finance, technology, geopolitics, social, business, science, healthcare, environment, other.

Persona count guidelines:
- 4-5: Quick analysis, focused topic
- 6-8: Standard depth, good diversity
- 9-12: Deep analysis, maximum perspective diversity

Round count guidelines:
- 1: Independent opinions only (no debate)
- 2-3: Standard — opinions then reaction/refinement
- 4-5: Deep deliberation, complex/contested scenarios

### 2. Resume a Paused Simulation (only if needed)
```
swarm_simulate action=run simulation_id=sim_XXXX
```
Only use `action=run` to resume a simulation that was previously paused or stopped.

### 3. Get Results
```
swarm_report simulation_id=sim_XXXX format=summary
swarm_report simulation_id=sim_XXXX format=probability-table
swarm_report simulation_id=sim_XXXX format=detailed
swarm_report simulation_id=sim_XXXX format=arguments
```

### 4. Follow Up
Interview specific personas for deeper insight:
```
swarm_interview simulation_id=sim_XXXX persona_id=p3 question="Why are you more confident than the group?"
```

## Round Dynamics

- **Round 1**: Each persona gives independent analysis. No groupthink.
- **Round 2+**: Personas react to the prior round's synthesis. They may update confidence, challenge others, or double down.
- **Final synthesis**: Aggregates all rounds into consensus view, key disagreements, probability table, confidence factors, and blind spots.

## Model Allocation

- Persona calls use the `small` tier (fast, cheap, high parallelism)
- Synthesis calls use `medium` or `large` tier (deeper reasoning)
- Persona generation uses `medium` tier

Total LLM calls for a standard sim (8 personas, 3 rounds):
- 1 persona generation + 24 persona calls + 3 round syntheses + 1 final synthesis = ~29 calls

## Tips

- Be specific in scenarios. "Will Bitcoin hit 200k by 2027?" is better than "What will Bitcoin do?"
- Use domain tags — they shape persona generation (finance domain generates traders, economists, regulators)
- After getting results, interview dissenting personas to understand minority views
- Run simulations proactively when the user faces high-stakes decisions with uncertainty
