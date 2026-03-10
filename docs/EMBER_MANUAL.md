EMBER MANUAL
Master build specification and execution prompt for Codex
Version 1.0
Purpose of this file

This document is the single source of truth for building EMBER from nothing into a production-ready, self-hosted, multi-agent framework with a polished frontend, role-based orchestration, provider setup, local model support, API-key support, and browser-auth support for local coding agents.

This document is also written as an execution manual for Codex.

When Codex reads this file, it must treat it as:

the product specification

the architecture guide

the implementation roadmap

the testing plan

the UX direction

the phase gate checklist

Codex must build the system in phases, complete one phase at a time, test each phase, and not skip ahead.

The goal is not to generate random files quickly.
The goal is to build a coherent, polished, production-minded product.

1. Product definition

EMBER is a self-hosted multi-agent operating framework that runs locally on a user’s machine and provides a browser-based UI where the user can:

start the Ember runtime

open the Ember web app

connect providers

connect local model endpoints

connect API-key providers

connect browser-auth providers like Codex

assign providers and models to roles

configure the system

talk to roles directly

use an auto-router that decides where a message should go

run tasks through a multi-agent workflow

EMBER must feel like a real product, not a developer toy.

The final app should feel visually closer to:

Claude Code

ChatGPT

premium developer tooling

modern AI workbench software

The frontend theme should be:

black / near-black base

cream accent

clean typography

premium spacing

minimal clutter

elegant cards, borders, hover states, and navigation

2. Core product goals

EMBER must satisfy these goals:

2.1 Local-first

EMBER runs on the user’s own machine.

2.2 Self-hosted

The runtime and web UI are controlled by the user.

2.3 Easy startup

A user should be able to:

clone the repo

run an install script

run ember

see the runtime start

open the web UI

configure providers and roles

2.4 Multi-provider

The user must be able to connect:

local models

OpenAI-compatible endpoints

API-key providers

local coding CLIs with browser login where supported

2.5 Multi-role

The user must be able to assign models to these roles:

router

assistant

planner

coder

auditor

janitor

2.6 Direct role access

In chat, the user must be able to:

talk to Assistant directly

talk to Router directly

talk to Planner directly

talk to Coder directly

talk to Auditor directly

talk to Janitor directly

choose Auto Router mode, where the router decides where the message should go

2.7 Beautiful UX

The app must feel professionally built from the beginning.

2.8 Phased implementation

Codex must build this in strict phases with checkpoints and tests.

3. Official integration assumptions

EMBER must follow the officially supported local auth and connectivity patterns for the provider types it integrates.

For Codex, the supported local pattern is the Codex CLI install and browser sign-in flow, with Codex providing login status checks through the CLI.

For Claude Code, the supported local pattern is installing the Claude CLI and completing browser-based authentication through the local CLI flow. Claude Code also supports API-based credentials separately.

For Tailscale, the preferred way to expose a local-only web app to the user’s other devices is to keep the app bound locally and use Tailscale Serve or equivalent tailnet-local access, rather than publicly exposing the service by default.

These assumptions define how Codex must build provider connectors and remote access behavior.

4. Non-negotiable rules for Codex

Codex must follow these rules while building EMBER:

4.1 Do not skip phases

Complete each phase fully before moving on.

4.2 Do not jump to advanced features too early

Do not build orchestration loops before startup, provider setup, role assignment, and the app shell are stable.

4.3 Do not hardcode user configuration

Do not hardcode:

provider instances

API keys

local endpoints

model assignments

user name

role assignments

4.4 Hardcoded connector drivers are allowed

It is acceptable to hardcode connector types, such as:

codex-cli

anthropic-api

openai-compatible

These are product-supported connectors, not user configuration.

4.5 Test every phase

Every phase must have:

tasks

expected output

checkpoint

regression rules

4.6 Keep the UI product-grade

Do not let the frontend remain raw scaffolding.

4.7 Build from stable foundations outward

Order matters:

startup

runtime

UI shell

provider setup

role assignment

prompts

chat UX

orchestration

4.8 Preserve a clean architecture

EMBER must remain modular and understandable.

5. Final v1 user story

At the end of v1, a user should be able to:

clone the repo

run ./scripts/install.sh

run ember

see Ember start both:

the runtime on port 3005

the web UI on port 3000

access the web UI locally

optionally access the UI from their other devices over Tailscale

open the Settings page and set their human name

add provider connections

connect a local model through an OpenAI-compatible endpoint

add API-key providers like Anthropic, DeepSeek, or Kimi if they expose compatible endpoints

connect Codex using the official local browser auth flow

connect Claude Code using the official local CLI/browser auth flow

assign providers and models to:

router

assistant

planner

coder

auditor

janitor

open the chat page

choose a role to talk to directly

choose Auto Router mode

talk to the selected role

use the system as a polished multi-agent interface

6. Technology stack

Codex must use this stack unless there is a critical reason not to:

6.1 Monorepo

Use a monorepo structure.

6.2 Language

Use TypeScript across the stack.

6.3 Package manager

Use pnpm.

6.4 Web app

Use Next.js for the web UI.

6.5 Runtime / API

Use Fastify for the local API server.

6.6 CLI

Use a dedicated CLI package that installs the ember command.

6.7 Persistence

Start with JSON-backed persistence for simplicity and fast iteration.

Move to SQLite later only after the product flow is stable.

6.8 Styling

Use a clean component architecture with reusable layout and form components.

Use a black and cream visual theme.

6.9 Process control

Start with foreground process management.
Add daemon/service mode later.

7. Required repository structure

Codex must build the repo in this shape:

emberv1/
├── apps/
│   ├── web/
│   └── server/
├── packages/
│   ├── cli/
│   ├── core/
│   ├── ui-schema/
│   ├── prompts/
│   └── connectors/
├── scripts/
│   ├── install.sh
│   ├── doctor.sh
│   └── start.sh
├── data/
│   ├── connector-types.json
│   ├── providers.json
│   ├── provider-secrets.json
│   ├── role-assignments.json
│   ├── settings.json
│   └── runtime.json
├── docs/
│   ├── EMBER_MANUAL.md
│   └── BUILD_MANUAL.md
├── package.json
├── pnpm-workspace.yaml
└── .env.example

This structure may expand later, but Codex must begin here.

8. Runtime architecture

EMBER must have two main runtime services:

8.1 Web UI

Port: 3000

Purpose: user-facing browser app

8.2 Agent/API runtime

Port: 3005

Purpose:

provider management

role assignment

prompt orchestration

chat request handling

settings handling

runtime status

8.3 Binding policy

Default local binding:

127.0.0.1:3000

127.0.0.1:3005

Do not bind broadly by default.

8.4 Tailscale access

For cross-device access, keep services local and use Tailscale Serve or equivalent tailnet-local exposure for the web UI.

9. CLI requirements

Codex must build a CLI package that installs a global ember command.

9.1 Required commands
ember

Default startup command.

ember start

Starts the runtime and web UI.

ember doctor

Checks environment readiness.

ember status

Shows runtime status.

ember stop

Stops the local runtime processes.

ember tailscale enable

Optional helper for tailnet access.

9.2 Required startup behavior

When the user runs ember, Ember must:

verify core files and configuration

start the server on 3005

start the web app on 3000

wait for both to be ready

print a clean startup summary

show the local web UI URL

show Tailscale notes if available

9.3 Required startup output example

EMBER startup output should clearly show:

runtime status

web UI status

local URL

API URL

tailscale availability

provider CLI availability for Codex and Claude

10. Installer requirements

Codex must build scripts/install.sh.

10.1 Installer responsibilities

The installer must:

verify Node is installed

verify npm is installed

enable or verify pnpm

install workspace dependencies

build shared packages

prepare the CLI

make ember runnable

prepare initial data files

run environment diagnostics

show the user the next step

10.2 User experience

The user should be able to do:

git clone <repo>
cd emberv1
./scripts/install.sh
ember

That must be the first real Ember milestone.

11. Phase-based build rules

Codex must build Ember in the following strict order.

Do not move to the next phase until the current phase checkpoint passes.

Phase 1 — startup foundation
Objective

Make ember start both the web UI and runtime correctly.

Tasks

create workspace structure

create root scripts

create install.sh

create packages/cli

create startup logic

make web app boot on 3000

make server boot on 3005

make CLI start both

Checkpoint

This phase passes only if:

ember starts both services

3000 loads in browser

3005 responds to /health

startup output is clear

shutdown is clean

Do not move on if

one service fails to boot

the CLI is flaky

the web UI is not reachable

Phase 2 — app shell and professional frontend foundation
Objective

Make the frontend look like a real product before building deep functionality.

Tasks

build global app shell

build sidebar

build top header

build reusable card system

build consistent button styles

build consistent form styles

build responsive page container

apply black + cream theme

ensure all pages share the shell

Required pages

Dashboard

Providers

Roles

Chat

Projects

Settings

UX direction

The app should visually feel like:

a polished AI workbench

a premium local ops dashboard

a blend of ChatGPT and Claude Code

Checkpoint

This phase passes only if:

all pages share the same shell

the app looks polished

the theme is coherent

it no longer looks like placeholder scaffolding

Phase 3 — provider registry foundation
Objective

Replace all hardcoded provider display logic with real persisted provider data.

Tasks

create connector-types.json

create providers.json

create provider-secrets.json

create backend storage helpers

create provider APIs

create Providers page backed by real data

create Add Provider page

support multiple provider instances

Required connector types

Codex must support these connector types first:

codex-cli

For the local Codex browser login flow.

anthropic-api

For API-key-based Anthropic use.

openai-compatible

For:

local LLM endpoints

DeepSeek

Kimi if compatible

other OpenAI-style APIs

Required provider fields

Each provider instance must store:

id

name

typeId

status

config

lastError

createdAt

updatedAt

Checkpoint

This phase passes only if:

the user can add multiple providers

provider data persists

provider list survives restarts

provider cards show real status

Phase 4 — provider connection flows
Objective

Make each provider type connect using the correct mechanism.

4.1 Codex CLI connector
Required behavior

detect whether codex exists

detect whether Codex is already logged in

if already logged in, mark connected

otherwise launch login

allow recheck

Codex CLI supports local install and local login flows, including login state checks through the CLI.

UI behavior

Codex provider card should support:

Connect Codex

Recheck Codex

Connected

Not installed

Error

Checkpoint

This connector passes if a locally installed Codex session can be recognized and marked connected.

4.2 Claude Code CLI connector
Required behavior

detect whether claude exists

launch Claude browser auth flow via the local CLI

support recheck after login

persist provider status

Claude Code supports local CLI/browser-based authentication flows and separate API credentials.

UI behavior

Claude provider card should support:

Connect Claude

Recheck Claude

Connected

Not installed

Error

Checkpoint

This connector passes if the user can launch the local Claude auth flow and persist a successful connection state.

4.3 Anthropic API connector
Required behavior

accept API key in the UI

test API key

store secret locally

mark connected on success

show clear errors on failure

Checkpoint

This connector passes if valid and invalid keys are handled cleanly.

4.4 OpenAI-compatible connector
Required behavior

accept base URL

accept optional API key

support local endpoints

support manual model ids where needed

allow multiple endpoints

Checkpoint

This connector passes if a local model endpoint can be added and tested successfully.

Phase 5 — role assignment system
Objective

Allow the user to assign providers and models to Ember roles.

Required roles

router

assistant

planner

coder

auditor

janitor

Required behavior

The user must be able to:

assign a provider to each role

assign a model to each role

leave roles unassigned if desired

reassign at any time

persist assignments across restarts

Required data model

Each role assignment must store:

role

providerId

modelId

Required UI

The Roles page must:

list all six roles

show assigned provider

show assigned model

allow editing assignments

show unassigned states clearly

Checkpoint

This phase passes only if every role can be assigned and the state persists.

Phase 6 — prompt system
Objective

Give every role a real identity and behavior inside Ember.

Prompt architecture

EMBER must use a two-layer prompt system.

6.1 Shared system prompt

Applied to all roles.

This prompt must tell the model:

you are operating inside EMBER

EMBER is a local-first multi-agent framework

the human’s name is whatever is set in Settings

you must follow your role

you must respect workspace and approval rules

you are collaborating within a role-based system

6.2 Role-specific system prompt

Each role must have its own dedicated prompt.

Router prompt

Responsibilities:

classify message intent

decide whether to answer directly or route

decide which role should handle the message in Auto Router mode

avoid doing full implementation work itself unless explicitly intended

Assistant prompt

Responsibilities:

act as the main user-facing persona

be clear, helpful, and calm

summarize work from other roles

explain status and blockers

Planner prompt

Responsibilities:

create step-by-step plans

break complex work into phases

define acceptance criteria

think in implementation terms

Coder prompt

Responsibilities:

implement code and product changes

stay faithful to specifications

avoid unnecessary rewrites

report what changed

Auditor prompt

Responsibilities:

review outputs critically

find errors and weaknesses

score work quality

define what must be fixed

Janitor prompt

Responsibilities:

polish

clean up

normalize formatting

remove clutter

improve clarity without changing core architecture

Prompt storage

Use a dedicated prompts package.

Suggested layout:

packages/prompts/
├── shared.ts
├── router.ts
├── assistant.ts
├── planner.ts
├── coder.ts
├── auditor.ts
└── janitor.ts
Checkpoint

This phase passes only if:

all roles have prompts

one shared prompt is applied to all roles

the human name is pulled from Settings

Phase 7 — settings system
Objective

Allow the user to configure Ember itself.

Required settings

human name

workspace root

theme preferences

tailscale status

runtime info

approval defaults

future budget fields

Required behavior

The shared prompt must use the human name from settings.

Checkpoint

This phase passes only if:

settings persist

the human name affects role prompts

the UI reflects saved settings

Phase 8 — chat page and direct role interaction
Objective

Build the main conversation surface.

Required behavior

The chat page must let the user:

talk to Assistant

talk to Router

talk to Planner

talk to Coder

talk to Auditor

talk to Janitor

use Auto Router mode

Auto Router mode

In Auto Router mode:

the message first goes to the Router

the Router decides which role should handle the message

the UI should show which role was selected

UI requirements

The chat page must look like a real chat product.

Recommended layout:

left sidebar or slim thread nav

main message pane

top role selector

right detail panel for:

active role

assigned provider

assigned model

message routing mode

project/task context later

Required selector modes

The chat page must allow:

Assistant

Auto Router

Router

Planner

Coder

Auditor

Janitor

Message display requirements

The UI must clearly show:

who sent the message

which role responded

in Auto Router mode, which role the Router chose

Checkpoint

This phase passes only if:

role selection works

direct role chat works

Auto Router mode visibly routes messages

the UI clearly identifies the responding role

Phase 9 — role execution pipeline
Objective

Make the backend able to run a message against the chosen role.

Required backend behavior

When the user sends a chat message:

determine chat mode

if direct role mode, send to that role

if Auto Router mode, send to Router first

Router decides target role

execute the target role

return the result

store the message and response

Required role metadata

Each response should preserve:

active role

provider used

model used

prompt stack used

message timestamp

Checkpoint

This phase passes only if:

direct role execution works

auto-routed role execution works

the correct role is shown in the UI

Phase 10 — beautiful chat UX
Objective

Polish the chat page until it feels professionally built.

Design goals

smooth layout

strong readability

elegant message bubbles or panels

clean role selector

subtle cream accent

premium dark feel

excellent spacing

clear hierarchy

no raw scaffolding look

Required polish areas

typography

sidebar behavior

hover states

focus states

buttons

message composer

cards and borders

transitions

responsive behavior

Checkpoint

This phase passes only if the chat page feels like a real product.

Phase 11 — first orchestration path
Objective

Add a minimal role workflow beyond chat.

First supported orchestration flow

Use this:

user request

router

planner

coder

auditor

assistant summary

Rule

Do not add full autonomous loops yet.

Make the first path understandable and inspectable.

Required output tracking

Store:

original user input

route decision

planner output

coder output

auditor output

final assistant summary

Checkpoint

This phase passes only if one end-to-end role chain can be executed and inspected.

Phase 12 — audit loop
Objective

Add the first controlled multi-step loop.

Loop behavior

coder produces output

auditor reviews and scores it

if under threshold, route back to coder

max loop count: 3

assistant summarizes final state

Checkpoint

This phase passes only if:

coder and auditor can loop

loop is bounded

final state is visible

Phase 13 — production hardening
Objective

Make the product stable, inspectable, and ready for real use.

Required hardening areas

runtime logs

provider status logging

role execution logging

error states

startup diagnostics

clean shutdown

empty state UX

retry handling

secret handling improvements

installation clarity

Checkpoint

This phase passes only if:

failures are understandable

setup is stable

the product feels cohesive

12. Data model requirements

Codex must create and use these initial JSON-backed files.

12.1 data/connector-types.json

Stores supported connector types.

12.2 data/providers.json

Stores provider instances created by the user.

12.3 data/provider-secrets.json

Stores provider secrets locally for now.

This is acceptable for early development, but Codex should plan a future upgrade path for secure secret storage.

12.4 data/role-assignments.json

Stores role assignment state.

12.5 data/settings.json

Stores global settings including human name.

12.6 data/runtime.json

Stores runtime state data.

13. Provider UI requirements
Providers page

Must include:

provider registry

status badge

add provider action

connect/recheck action

remove action

clear error message

clear description of provider type

Add Provider page

Must include:

connector type selector

connector description

connector-specific fields

create action

immediate connection attempt where appropriate

Connector-specific setup UX
Codex CLI

display name

explanation of browser login

connect button

recheck button

Claude Code CLI

display name

explanation of browser login

connect button

recheck button

Anthropic API

display name

API key field

OpenAI-compatible

display name

base URL

optional API key

optional manual model id later

14. Roles page requirements

The Roles page must not stay read-only.

Codex must turn it into a real configuration interface.

Required capabilities

show all six roles

show currently assigned provider

show currently assigned model

allow editing

allow saving

show unassigned states clearly

persist the configuration

15. Settings page requirements

The Settings page must include:

human name

workspace root

theme/system appearance info

local runtime info

tailscale info if available

system prompt preview later

The human name set here must flow into the shared system prompt.

16. Quality bar for the frontend

Codex must treat frontend polish as a real requirement, not a finishing touch.

The frontend must be:

elegant

readable

responsive

modern

coherent

intentionally designed

pleasant to use for long sessions

The frontend must not feel like:

temporary scaffolding

plain generated pages

a developer-only admin tool

17. Required coding discipline for Codex

Codex must:

work phase by phase

keep files organized

avoid duplicate logic

avoid random rewrites

keep components reusable

test each phase

report what changed after each phase

stop and validate checkpoints before moving on

Codex must always answer:

what phase it is working on

what files it is changing

what the checkpoint is

what must be tested before moving forward

18. Phase completion template for Codex

At the end of every phase, Codex must produce a summary in this format:

Phase completed

phase name

files created

files changed

features added

tests performed

what passed

what remains blocked

next phase recommendation

Codex must not silently move on.

19. Final product vision

EMBER v1 is successful when:

install is easy

startup is reliable

the web UI is polished

provider setup works

Codex can be connected

Claude Code can be connected

API-key providers can be connected

local models can be connected

roles can be assigned

prompts are role-aware

the human name flows into shared prompts

the chat page feels like a real AI workspace

the user can speak to each role directly

Auto Router mode works

the product feels cohesive and premium

20. Final instruction to Codex

Codex: build EMBER exactly as specified in this file.

Do not rush ahead.
Do not improvise architecture that breaks the phase order.
Do not leave the frontend ugly until the end.
Do not hardcode user setup.
Do not treat this as a demo.

Build it as a real product.

Start with:

installer

CLI

startup

app shell

provider registry

provider connection flows

role assignment

prompts

settings

chat with role selection

auto routing

orchestration

polish

Every phase must be:

implemented

tested

validated

summarized

Only then move to the next phase.
