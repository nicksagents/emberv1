"use client";

import { useEffect, useRef } from "react";

import type {
  MemoryGraphClusterView,
  MemoryGraphLinkView,
  MemoryGraphNodeView,
  MemoryGraphPayloadView,
} from "./memory-schema";

type RenderNode = MemoryGraphNodeView & {
  x: number;
  y: number;
  z: number;
  radius: number;
  screenX: number;
  screenY: number;
  depthScale: number;
  hemisphere: -1 | 1;
};

type RenderCluster = MemoryGraphClusterView & {
  x: number;
  y: number;
  z: number;
  screenX: number;
  screenY: number;
  depthScale: number;
  hemisphere: -1 | 1;
};

type RenderLink = MemoryGraphLinkView & {
  a: number;
  b: number;
};

type RenderParticle = {
  baseX: number;
  baseY: number;
  baseZ: number;
  drift: number;
  phase: number;
  size: number;
  alpha: number;
  screenX: number;
  screenY: number;
  depthScale: number;
};

const COLOR_BY_TYPE: Record<string, [number, number, number]> = {
  user_profile: [255, 243, 176],
  user_preference: [255, 153, 102],
  project_fact: [255, 214, 130],
  environment_fact: [255, 186, 73],
  world_fact: [110, 211, 255],
  episode_summary: [255, 129, 129],
  task_outcome: [255, 87, 87],
  warning_or_constraint: [208, 170, 255],
};

const CLUSTER_TINTS: Record<MemoryGraphClusterView["kind"], [number, number, number]> = {
  self: [255, 184, 102],
  workspace: [255, 122, 89],
  world: [110, 211, 255],
  session: [255, 98, 128],
  constraint: [187, 146, 255],
};

function getNodeColor(memoryType: string): [number, number, number] {
  return COLOR_BY_TYPE[memoryType] ?? [255, 178, 92];
}

function getClusterColor(kind: MemoryGraphClusterView["kind"]): [number, number, number] {
  return CLUSTER_TINTS[kind] ?? [255, 178, 92];
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnit(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453123;
  return x - Math.floor(x);
}

function getClusterAnchor(
  cluster: MemoryGraphClusterView,
  index: number,
  total: number,
  radius: number,
  hemisphere: -1 | 1,
): { x: number; y: number; z: number } {
  const seed = hashString(cluster.id);
  const t = total <= 1 ? 0.5 : index / (total - 1);
  const theta = t * Math.PI * 1.08 + seededUnit(seed + 3) * 0.32;
  const bias = getLobeBias(cluster.kind);
  const shell = 0.92 + seededUnit(seed + 11) * 0.34;
  const xBase = hemisphere * radius * (1.02 + Math.sin(theta) * 0.22 + shell * 0.18 + bias.x);
  const yBase = Math.cos(theta * 1.15 + seededUnit(seed + 17) * 0.4) * radius * 0.46 + bias.y * radius;
  const zBase = Math.sin(theta * 0.82 + seededUnit(seed + 23) * 0.52) * radius * 0.86 + bias.z * radius;
  const silhouetteTaper =
    1 -
    Math.min(0.12, Math.abs(yBase) / (radius * 3.8)) -
    Math.min(0.1, Math.abs(zBase) / (radius * 5.6));

  return {
    x: xBase * silhouetteTaper,
    y: yBase,
    z: zBase,
  };
}

function getNodeOffset(
  node: MemoryGraphNodeView,
  index: number,
  total: number,
  radius: number,
  hemisphere: -1 | 1,
): { x: number; y: number; z: number } {
  const seed = hashString(node.id);
  const t = total <= 1 ? 0.5 : index / (total - 1);
  const phi = Math.acos(1 - 2 * t);
  const theta = Math.PI * (1 + Math.sqrt(5)) * index + seededUnit(seed) * Math.PI * 2;
  const jitter = 0.72 + seededUnit(seed + 9) * 0.48;
  const gyri = 0.88 + Math.sin(theta * 3.4 + seededUnit(seed + 27) * Math.PI * 2) * 0.14;
  const fissureLift = hemisphere * radius * 0.06;

  return {
    x: Math.cos(theta) * Math.sin(phi) * radius * 1.22 * jitter * gyri + fissureLift,
    y:
      Math.cos(phi) *
      radius *
      0.7 *
      (0.84 + seededUnit(seed + 13) * 0.18) *
      (1 - Math.min(0.14, Math.abs(Math.cos(theta)) * 0.12)),
    z: Math.sin(theta) * Math.sin(phi) * radius * 0.98 * (0.78 + seededUnit(seed + 19) * 0.26),
  };
}

function getClusterHemisphere(cluster: MemoryGraphClusterView, index: number): -1 | 1 {
  switch (cluster.kind) {
    case "self":
    case "workspace":
      return -1;
    case "world":
    case "session":
      return 1;
    case "constraint":
      return (hashString(cluster.id) + index) % 2 === 0 ? -1 : 1;
  }
}

function getLobeBias(kind: MemoryGraphClusterView["kind"]): { x: number; y: number; z: number } {
  switch (kind) {
    case "self":
      return { x: -0.02, y: 0.08, z: -0.26 };
    case "workspace":
      return { x: 0, y: -0.16, z: 0.04 };
    case "world":
      return { x: 0.02, y: 0.04, z: 0.42 };
    case "session":
      return { x: 0.01, y: -0.2, z: 0.18 };
    case "constraint":
      return { x: 0, y: 0.2, z: -0.08 };
  }
}

function buildEnvironmentParticles(count: number, radius: number): RenderParticle[] {
  return Array.from({ length: count }, (_, index) => {
    const seed = index + 1;
    const phi = Math.acos(1 - 2 * seededUnit(seed + 17));
    const theta = seededUnit(seed + 31) * Math.PI * 2;
    const shell = 1.2 + seededUnit(seed + 43) * 0.95;
    const x = Math.cos(theta) * Math.sin(phi) * radius * 1.7 * shell;
    const y = Math.cos(phi) * radius * 0.88 * (0.64 + seededUnit(seed + 53) * 0.48);
    const z = Math.sin(theta) * Math.sin(phi) * radius * 1.22 * shell;

    return {
      baseX: x,
      baseY: y,
      baseZ: z,
      drift: 1.4 + seededUnit(seed + 67) * 2.6,
      phase: seededUnit(seed + 71) * Math.PI * 2,
      size: 0.7 + seededUnit(seed + 79) * 1.5,
      alpha: 0.08 + seededUnit(seed + 89) * 0.18,
      screenX: 0,
      screenY: 0,
      depthScale: 1,
    };
  });
}

export function MemoryConstellation({
  graph,
  selectedId,
  onSelectId,
}: {
  graph: MemoryGraphPayloadView;
  selectedId: string | null;
  onSelectId: (id: string | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const selectedIdRef = useRef<string | null>(selectedId);
  const stateRef = useRef<{
    nodes: RenderNode[];
    clusters: RenderCluster[];
    links: RenderLink[];
    particles: RenderParticle[];
    rotationY: number;
    rotationX: number;
    dragging: boolean;
    hoverIndex: number;
    pulses: Array<{ linkIndex: number; t: number; speed: number }>;
  }>({
    nodes: [],
    clusters: [],
    links: [],
    particles: [],
    rotationY: 0,
    rotationX: -0.22,
    dragging: false,
    hoverIndex: -1,
    pulses: [],
  });

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return;
    }

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      canvas.width = Math.floor(canvas.clientWidth * ratio);
      canvas.height = Math.floor(canvas.clientHeight * ratio);
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    };

    resize();
    window.addEventListener("resize", resize);

    const bounds = () => ({
      width: canvas.clientWidth,
      height: canvas.clientHeight,
    });

    const clusterRadius = Math.min(bounds().width, bounds().height) * 0.16;
    const hemisphereCounts = new Map<-1 | 1, number>();
    for (let index = 0; index < graph.clusters.length; index += 1) {
      const hemisphere = getClusterHemisphere(graph.clusters[index]!, index);
      hemisphereCounts.set(hemisphere, (hemisphereCounts.get(hemisphere) ?? 0) + 1);
    }
    const seenByHemisphere = new Map<-1 | 1, number>();
    const clusterIndexById = new Map<string, number>();
    const clusters: RenderCluster[] = graph.clusters.map((cluster, index) => {
      const hemisphere = getClusterHemisphere(cluster, index);
      const localIndex = seenByHemisphere.get(hemisphere) ?? 0;
      seenByHemisphere.set(hemisphere, localIndex + 1);
      clusterIndexById.set(cluster.id, index);
      const position = getClusterAnchor(
        cluster,
        localIndex,
        hemisphereCounts.get(hemisphere) ?? 1,
        clusterRadius * 2.12,
        hemisphere,
      );
      return {
        ...cluster,
        ...position,
        screenX: 0,
        screenY: 0,
        depthScale: 1,
        hemisphere,
      };
    });

    const countsByCluster = new Map<string, number>();
    for (const node of graph.nodes) {
      countsByCluster.set(node.clusterId, (countsByCluster.get(node.clusterId) ?? 0) + 1);
    }
    const seenByCluster = new Map<string, number>();
    const nodes: RenderNode[] = graph.nodes.map((node) => {
      const clusterIndex = clusterIndexById.get(node.clusterId) ?? 0;
      const cluster = clusters[clusterIndex] ?? clusters[0] ?? {
        x: 0,
        y: 0,
        z: 0,
      };
      const localIndex = seenByCluster.get(node.clusterId) ?? 0;
      seenByCluster.set(node.clusterId, localIndex + 1);
      const clusterCount = countsByCluster.get(node.clusterId) ?? 1;
      const localRadius = Math.max(18, clusterRadius * (0.42 + Math.min(1.1, clusterCount / 14)));
      const offset = getNodeOffset(node, localIndex, clusterCount, localRadius, cluster.hemisphere);

      return {
        ...node,
        x: cluster.x + offset.x,
        y: cluster.y + offset.y,
        z: cluster.z + offset.z,
        radius: Math.max(1.5, Math.min(8.6, node.size)),
        screenX: 0,
        screenY: 0,
        depthScale: 1,
        hemisphere: cluster.hemisphere,
      };
    });

    const nodeIndexById = new Map<string, number>();
    nodes.forEach((node, index) => {
      nodeIndexById.set(node.id, index);
    });
    const links: RenderLink[] = graph.links
      .map((link) => {
        const a = nodeIndexById.get(link.source);
        const b = nodeIndexById.get(link.target);
        if (a == null || b == null) {
          return null;
        }
        return { ...link, a, b };
      })
      .filter((link): link is RenderLink => Boolean(link));

    stateRef.current.nodes = nodes;
    stateRef.current.clusters = clusters;
    stateRef.current.links = links;
    stateRef.current.particles = buildEnvironmentParticles(160, clusterRadius * 2.2);
    stateRef.current.hoverIndex = -1;
    stateRef.current.pulses = Array.from({
      length: Math.min(Math.max(20, links.length * 2), 140),
    }).map((_, index) => {
      const linkIndex = links.length > 0 ? index % links.length : 0;
      return {
        linkIndex,
        t: seededUnit(index + 1),
        speed: (links[linkIndex]?.pulseRate ?? 0.0032) + seededUnit(index + 77) * 0.002,
      };
    });

    const project = (target: { x: number; y: number; z: number; screenX: number; screenY: number; depthScale: number }) => {
      const { width, height } = bounds();
      const state = stateRef.current;
      const cosY = Math.cos(state.rotationY);
      const sinY = Math.sin(state.rotationY);
      const cosX = Math.cos(state.rotationX);
      const sinX = Math.sin(state.rotationX);

      const x1 = target.x * cosY - target.z * sinY;
      const z1 = target.x * sinY + target.z * cosY;
      const y2 = target.y * cosX - z1 * sinX;
      const z2 = target.y * sinX + z1 * cosX;
      const camera = Math.max(width, height) * 1.28;
      const perspective = camera / (camera - z2);

      target.depthScale = perspective;
      target.screenX = width * 0.5 + x1 * perspective;
      target.screenY = height * 0.53 + y2 * perspective;
    };

    const updateHover = (clientX: number, clientY: number) => {
      const rect = canvas.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      let hoverIndex = -1;
      let minDistance = Infinity;

      for (let index = 0; index < stateRef.current.nodes.length; index += 1) {
        const node = stateRef.current.nodes[index]!;
        const radius = node.radius * node.depthScale + 8;
        const distance = Math.hypot(node.screenX - x, node.screenY - y);
        if (distance <= radius && distance < minDistance) {
          hoverIndex = index;
          minDistance = distance;
        }
      }

      stateRef.current.hoverIndex = hoverIndex;
    };

    const onMouseMove = (event: MouseEvent) => {
      updateHover(event.clientX, event.clientY);
      if (!stateRef.current.dragging) {
        return;
      }
      stateRef.current.rotationY += event.movementX * 0.0056;
      stateRef.current.rotationX = Math.max(
        -0.76,
        Math.min(0.76, stateRef.current.rotationX + event.movementY * 0.0042),
      );
    };

    const onMouseDown = () => {
      stateRef.current.dragging = true;
    };

    const onMouseUp = () => {
      stateRef.current.dragging = false;
    };

    const onMouseLeave = () => {
      stateRef.current.dragging = false;
      stateRef.current.hoverIndex = -1;
    };

    const onClick = () => {
      const hovered = stateRef.current.hoverIndex;
      onSelectId(hovered >= 0 ? stateRef.current.nodes[hovered]?.id ?? null : null);
    };

    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("mouseleave", onMouseLeave);
    window.addEventListener("mouseup", onMouseUp);
    canvas.addEventListener("click", onClick);

    let frameId = 0;
    const animate = () => {
      const { width, height } = bounds();
      const state = stateRef.current;
      const now = performance.now();

      if (!state.dragging) {
        state.rotationY += 0.0012;
        const ambientX = -0.22 + Math.sin(now * 0.00022) * 0.06;
        state.rotationX += (ambientX - state.rotationX) * 0.018;
      }

      ctx.clearRect(0, 0, width, height);

      const background = ctx.createRadialGradient(
        width * 0.5,
        height * 0.4,
        40,
        width * 0.5,
        height * 0.55,
        Math.max(width, height) * 0.85,
      );
      background.addColorStop(0, "rgba(28, 22, 18, 0.94)");
      background.addColorStop(0.28, "rgba(12, 9, 8, 0.98)");
      background.addColorStop(1, "rgba(2, 2, 4, 1)");
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, width, height);

      ctx.fillStyle = "rgba(18, 14, 12, 0.52)";
      ctx.fillRect(width * 0.492, height * 0.12, width * 0.016, height * 0.6);

      for (const cluster of state.clusters) {
        project(cluster);
      }
      for (const node of state.nodes) {
        project(node);
      }

      const sortedNodes = [...state.nodes].sort((left, right) => left.depthScale - right.depthScale);
      const leftNodes = state.nodes.filter((node) => node.hemisphere === -1);
      const rightNodes = state.nodes.filter((node) => node.hemisphere === 1);

      drawHemisphereShell(ctx, leftNodes, getClusterColor("workspace"));
      drawHemisphereShell(ctx, rightNodes, getClusterColor("world"));
      drawCorpusBridge(ctx, leftNodes, rightNodes);

      for (const particle of state.particles) {
        const wobble = Math.sin(now * 0.00028 * particle.drift + particle.phase);
        const x = particle.baseX + wobble * 8;
        const y = particle.baseY + Math.cos(now * 0.00022 * particle.drift + particle.phase) * 5;
        const z = particle.baseZ + wobble * 16;
        const projected = {
          x,
          y,
          z,
          screenX: 0,
          screenY: 0,
          depthScale: 1,
        };
        project(projected);
        const alpha = particle.alpha * Math.max(0.24, Math.min(1, projected.depthScale * 0.9));
        ctx.fillStyle = `rgba(255, 226, 198, ${alpha})`;
        ctx.beginPath();
        ctx.arc(projected.screenX, projected.screenY, particle.size * projected.depthScale, 0, Math.PI * 2);
        ctx.fill();
      }

      for (const cluster of state.clusters) {
        const [r, g, b] = getClusterColor(cluster.kind);
        const radius = Math.max(80, 160 * cluster.depthScale * (0.5 + cluster.energy));
        const aura = ctx.createRadialGradient(
          cluster.screenX,
          cluster.screenY,
          0,
          cluster.screenX,
          cluster.screenY,
          radius,
        );
        aura.addColorStop(0, `rgba(${r},${g},${b},0.18)`);
        aura.addColorStop(0.45, `rgba(${r},${g},${b},0.06)`);
        aura.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = aura;
        ctx.beginPath();
        ctx.arc(cluster.screenX, cluster.screenY, radius, 0, Math.PI * 2);
        ctx.fill();
      }

      for (const link of state.links) {
        const left = state.nodes[link.a]!;
        const right = state.nodes[link.b]!;
        const activation = Math.max(left.energy, right.energy);
        const alpha = Math.max(0.05, Math.min(0.24, link.weight * 0.24 + activation * 0.08));
        ctx.strokeStyle = `rgba(255, 228, 196, ${alpha})`;
        ctx.lineWidth = Math.max(0.5, link.weight * 0.9 * ((left.depthScale + right.depthScale) * 0.5));
        ctx.beginPath();
        ctx.moveTo(left.screenX, left.screenY);
        ctx.lineTo(right.screenX, right.screenY);
        ctx.stroke();
      }

      for (const pulse of state.pulses) {
        const link = state.links[pulse.linkIndex];
        if (!link) {
          continue;
        }
        const left = state.nodes[link.a]!;
        const right = state.nodes[link.b]!;
        pulse.t += pulse.speed;
        if (pulse.t > 1) {
          pulse.t = 0;
        }
        const x = left.screenX + (right.screenX - left.screenX) * pulse.t;
        const y = left.screenY + (right.screenY - left.screenY) * pulse.t;
        const glow = Math.max(left.energy, right.energy, 0.4);
        ctx.fillStyle = `rgba(255, 176, 92, ${0.72 + glow * 0.24})`;
        ctx.shadowBlur = 16 + glow * 8;
        ctx.shadowColor = "rgba(255, 149, 0, 0.7)";
        ctx.beginPath();
        ctx.arc(x, y, 1.4 + glow * 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      for (const node of sortedNodes) {
        const [r, g, b] = getNodeColor(node.colorKey);
        const hover = state.hoverIndex >= 0 && state.nodes[state.hoverIndex]?.id === node.id;
        const selected = selectedIdRef.current === node.id;
        const stale = node.status !== "active" || node.needsRevalidation;
        const glowRadius = node.radius * node.depthScale * (selected ? 8 : hover ? 6.6 : 5.2);

        const glow = ctx.createRadialGradient(
          node.screenX,
          node.screenY,
          0,
          node.screenX,
          node.screenY,
          glowRadius,
        );
        glow.addColorStop(0, `rgba(${r},${g},${b},${selected ? 0.4 : 0.28})`);
        glow.addColorStop(0.5, `rgba(${r},${g},${b},${stale ? 0.08 : 0.16})`);
        glow.addColorStop(1, "rgba(0,0,0,0)");
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(node.screenX, node.screenY, glowRadius, 0, Math.PI * 2);
        ctx.fill();

        if (selected) {
          ctx.strokeStyle = "rgba(255, 248, 230, 0.82)";
          ctx.lineWidth = 1.4;
          ctx.beginPath();
          ctx.arc(node.screenX, node.screenY, node.radius * node.depthScale * 1.7, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.shadowBlur = selected ? 24 : hover ? 18 : 10;
        ctx.shadowColor = `rgba(${r},${g},${b},0.75)`;
        ctx.fillStyle = `rgba(${r},${g},${b},${stale ? 0.55 : 0.95})`;
        ctx.beginPath();
        ctx.arc(
          node.screenX,
          node.screenY,
          node.radius * node.depthScale * (selected ? 1.28 : hover ? 1.14 : 1),
          0,
          Math.PI * 2,
        );
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      if (state.hoverIndex >= 0) {
        const hovered = state.nodes[state.hoverIndex]!;
        ctx.fillStyle = "rgba(255, 247, 235, 0.92)";
        ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, monospace";
        ctx.fillText(hovered.label, hovered.screenX + 12, hovered.screenY - 12);
      }

      frameId = window.requestAnimationFrame(animate);
    };

    frameId = window.requestAnimationFrame(animate);

    return () => {
      window.removeEventListener("resize", resize);
      canvas.removeEventListener("mousemove", onMouseMove);
      canvas.removeEventListener("mousedown", onMouseDown);
      canvas.removeEventListener("mouseleave", onMouseLeave);
      window.removeEventListener("mouseup", onMouseUp);
      canvas.removeEventListener("click", onClick);
      window.cancelAnimationFrame(frameId);
    };
  }, [graph, onSelectId]);

  return <canvas ref={canvasRef} className="memory-constellation-canvas" />;
}

function drawHemisphereShell(
  ctx: CanvasRenderingContext2D,
  nodes: RenderNode[],
  color: [number, number, number],
): void {
  if (nodes.length < 4) {
    return;
  }

  const xs = nodes.map((node) => node.screenX);
  const ys = nodes.map((node) => node.screenY);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const centerX = (minX + maxX) * 0.5;
  const centerY = (minY + maxY) * 0.5;
  const radiusX = Math.max(70, (maxX - minX) * 0.64);
  const radiusY = Math.max(56, (maxY - minY) * 0.74);
  const [r, g, b] = color;

  const fill = ctx.createRadialGradient(centerX, centerY, radiusX * 0.12, centerX, centerY, radiusX * 1.08);
  fill.addColorStop(0, `rgba(${r},${g},${b},0.08)`);
  fill.addColorStop(0.58, `rgba(${r},${g},${b},0.028)`);
  fill.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.ellipse(centerX, centerY, radiusX * 1.08, radiusY * 1.08, 0, 0, Math.PI * 2);
  ctx.fill();

  for (let ring = 0; ring < 3; ring += 1) {
    const scale = 1 + ring * 0.12;
    ctx.strokeStyle = `rgba(${r},${g},${b},${0.07 - ring * 0.014})`;
    ctx.lineWidth = 1.1 - ring * 0.18;
    ctx.beginPath();
    ctx.ellipse(centerX, centerY, radiusX * scale, radiusY * scale, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawCorpusBridge(
  ctx: CanvasRenderingContext2D,
  leftNodes: RenderNode[],
  rightNodes: RenderNode[],
): void {
  if (leftNodes.length < 3 || rightNodes.length < 3) {
    return;
  }

  const leftEdge = leftNodes.reduce((best, node) => (node.screenX > best.screenX ? node : best), leftNodes[0]!);
  const rightEdge = rightNodes.reduce((best, node) => (node.screenX < best.screenX ? node : best), rightNodes[0]!);
  const midX = (leftEdge.screenX + rightEdge.screenX) * 0.5;
  const midY = (leftEdge.screenY + rightEdge.screenY) * 0.5 - 10;
  const spread = Math.max(28, Math.abs(rightEdge.screenX - leftEdge.screenX) * 0.18);

  const glow = ctx.createLinearGradient(leftEdge.screenX, midY, rightEdge.screenX, midY);
  glow.addColorStop(0, "rgba(255, 170, 118, 0.04)");
  glow.addColorStop(0.5, "rgba(255, 224, 194, 0.12)");
  glow.addColorStop(1, "rgba(136, 210, 255, 0.04)");
  ctx.strokeStyle = glow;
  ctx.lineWidth = 12;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(leftEdge.screenX, leftEdge.screenY);
  ctx.bezierCurveTo(
    midX - spread,
    leftEdge.screenY - 18,
    midX + spread,
    rightEdge.screenY - 18,
    rightEdge.screenX,
    rightEdge.screenY,
  );
  ctx.stroke();

  ctx.strokeStyle = "rgba(255, 238, 220, 0.12)";
  ctx.lineWidth = 3.2;
  ctx.beginPath();
  ctx.moveTo(leftEdge.screenX, leftEdge.screenY);
  ctx.quadraticCurveTo(midX, midY, rightEdge.screenX, rightEdge.screenY);
  ctx.stroke();

  const pulse = ctx.createRadialGradient(midX, midY, 0, midX, midY, 44);
  pulse.addColorStop(0, "rgba(255, 236, 214, 0.18)");
  pulse.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = pulse;
  ctx.beginPath();
  ctx.arc(midX, midY, 44, 0, Math.PI * 2);
  ctx.fill();
}
