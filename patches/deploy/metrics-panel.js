#!/usr/bin/env node
/**
 * Toonflow host metrics panel.
 *
 * Dependency-free Node server: reads /proc for CPU and memory, statfs for disks, and
 * the Docker socket for per-container usage. The dashboard polls /api/metrics once a
 * second and draws a rolling CPU sparkline.
 *
 * Why not Prometheus + Grafana: this sandbox has limited root disk and gets recycled,
 * so a single self-contained file survives better than a stack that needs its own
 * storage, ports and service management.
 */

"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");

const PORT = Number(process.env.MONITOR_PORT || 3003);
const DOCKER_SOCKET = "/var/run/docker.sock";

function readCpuSample() {
  const line = fs.readFileSync("/proc/stat", "utf8").split("\n")[0];
  // Fields: user nice system idle iowait irq softirq steal ...
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  const idle = (parts[3] || 0) + (parts[4] || 0);
  let total = 0;
  for (const value of parts) total += value || 0;
  return { idle, total };
}

let previousCpu = readCpuSample();

function readMemory() {
  const text = fs.readFileSync("/proc/meminfo", "utf8");
  const pick = (key) => {
    const match = text.match(new RegExp("^" + key + ":\\s+(\\d+)", "m"));
    return match ? Number(match[1]) * 1024 : 0;
  };
  const total = pick("MemTotal");
  const available = pick("MemAvailable");
  const buffers = pick("Buffers");
  const cached = pick("Cached");
  const swapTotal = pick("SwapTotal");
  const swapFree = pick("SwapFree");
  const used = total - available;
  return {
    total,
    used,
    available,
    cached: buffers + cached,
    swapTotal,
    swapUsed: swapTotal - swapFree,
    percent: total ? (used / total) * 100 : 0,
  };
}

function readLoad() {
  const parts = fs.readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/);
  return { one: Number(parts[0]), five: Number(parts[1]), fifteen: Number(parts[2]) };
}

function readUptime() {
  return Number(fs.readFileSync("/proc/uptime", "utf8").split(" ")[0]);
}

/** Talk to the Docker Engine API over its unix socket without any client library. */
function dockerRequest(path) {
  return new Promise((resolve) => {
    const request = http.request({ socketPath: DOCKER_SOCKET, path, method: "GET" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () => {
        try {
          resolve(JSON.parse(body));
        } catch {
          resolve(null);
        }
      });
    });
    request.on("error", () => resolve(null));
    request.setTimeout(4000, () => {
      request.destroy();
      resolve(null);
    });
    request.end();
  });
}

function readDisks() {
  const disks = [];
  for (const mount of ["/", "/data"]) {
    try {
      const stat = fs.statfsSync(mount);
      const total = stat.blocks * stat.bsize;
      const available = stat.bavail * stat.bsize;
      const used = total - stat.bfree * stat.bsize;
      disks.push({ mount, total, used, available, percent: total ? (used / total) * 100 : 0 });
    } catch {
      // /data only exists on this sandbox; skip silently elsewhere.
    }
  }
  return disks;
}

async function readContainers() {
  const list = await dockerRequest("/containers/json");
  if (!Array.isArray(list)) return { all: [], running: 0 };

  const containers = [];
  for (const item of list) {
    const name = (item.Names && item.Names[0] ? item.Names[0] : "").replace(/^\//, "");
    const state = item.State || "unknown";
    let cpuPercent = 0;
    let memUsed = 0;
    let memLimit = 0;

    if (state === "running") {
      const stats = await dockerRequest("/containers/" + item.Id + "/stats?stream=false");
      if (stats && stats.cpu_stats) {
        const cpuDelta =
          (stats.cpu_stats.cpu_usage ? stats.cpu_stats.cpu_usage.total_usage : 0) -
          (stats.precpu_stats && stats.precpu_stats.cpu_usage ? stats.precpu_stats.cpu_usage.total_usage : 0);
        const systemDelta =
          (stats.cpu_stats.system_cpu_usage || 0) -
          (stats.precpu_stats ? stats.precpu_stats.system_cpu_usage || 0 : 0);
        const cores = stats.cpu_stats.online_cpus || 1;
        cpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * cores * 100 : 0;
        const memStats = stats.memory_stats || {};
        memUsed = (memStats.usage || 0) - (memStats.stats && memStats.stats.cache ? memStats.stats.cache : 0);
        memLimit = memStats.limit || 0;
      }
    }

    containers.push({
      name,
      image: item.Image || "",
      state,
      status: item.Status || "",
      cpuPercent: Math.max(0, cpuPercent),
      memUsed: Math.max(0, memUsed),
      memLimit,
    });
  }
  return { all: containers, running: containers.filter((c) => c.state === "running").length };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");

  if (url.pathname === "/api/metrics") {
    const current = readCpuSample();
    const idleDelta = current.idle - previousCpu.idle;
    const totalDelta = current.total - previousCpu.total;
    previousCpu = current;
    const cpuPercent = totalDelta > 0 ? (1 - idleDelta / totalDelta) * 100 : 0;

    const containers = await readContainers();
    const payload = {
      time: Date.now(),
      cpu: {
        percent: Math.max(0, Math.min(100, cpuPercent)),
        cores: os.cpus().length,
        load: readLoad(),
      },
      memory: readMemory(),
      disks: readDisks(),
      uptime: readUptime(),
      containers: containers.all,
      containersRunning: containers.running,
    };
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    response.end(JSON.stringify(payload));
    return;
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(DASHBOARD);
    return;
  }

  response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  response.end("not found");
});

const DASHBOARD = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Toonflow 服务器状态</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 20px; background: #0f1116; color: #e6e8ee;
         font: 14px/1.5 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
  h1 { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
  .sub { color: #8b93a7; font-size: 12px; margin-bottom: 18px; }
  .grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
  .card { background: #171922; border: 1px solid #242835; border-radius: 10px; padding: 16px; }
  .label { color: #8b93a7; font-size: 12px; letter-spacing: .3px; text-transform: uppercase; }
  .value { font-size: 26px; font-weight: 650; margin: 6px 0 2px; font-variant-numeric: tabular-nums; }
  .meta { color: #77809a; font-size: 12px; font-variant-numeric: tabular-nums; }
  .bar { height: 6px; background: #242835; border-radius: 3px; overflow: hidden; margin-top: 10px; }
  .bar > i { display: block; height: 100%; background: #4c8dff; transition: width .4s ease; }
  .bar.warn > i { background: #f0a92c; }
  .bar.crit > i { background: #e5564b; }
  table { width: 100%; border-collapse: collapse; margin-top: 10px; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #222633; }
  th { color: #8b93a7; font-weight: 500; font-size: 11px; text-transform: uppercase; }
  td.num { font-variant-numeric: tabular-nums; }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: #3ecf8e; margin-right: 6px; }
  .dot.off { background: #e5564b; }
  canvas { width: 100%; height: 60px; display: block; margin-top: 10px; }
  .err { color: #e5564b; }
</style>
</head>
<body>
<h1>Toonflow 服务器状态</h1>
<div class="sub" id="sub">连接中…</div>
<div class="grid">
  <div class="card">
    <div class="label">CPU</div>
    <div class="value" id="cpu">–</div>
    <div class="meta" id="cpumeta">–</div>
    <div class="bar" id="cpubar"><i style="width:0"></i></div>
    <canvas id="cpuchart" width="600" height="120"></canvas>
  </div>
  <div class="card">
    <div class="label">内存</div>
    <div class="value" id="mem">–</div>
    <div class="meta" id="memmeta">–</div>
    <div class="bar" id="membar"><i style="width:0"></i></div>
  </div>
  <div class="card">
    <div class="label">磁盘</div>
    <div id="diskbody" class="meta">–</div>
  </div>
  <div class="card">
    <div class="label">运行时长</div>
    <div class="value" id="uptime">–</div>
    <div class="meta" id="containers">–</div>
  </div>
</div>
<div class="card" style="margin-top:14px">
  <div class="label">容器</div>
  <table>
    <thead><tr><th>名称</th><th>状态</th><th>CPU</th><th>内存</th></tr></thead>
    <tbody id="ctable"><tr><td colspan="4" class="meta">–</td></tr></tbody>
  </table>
</div>
<script>
var cpuHistory = [];
var MAX_POINTS = 60;

function bytes(value) {
  if (!value) return "0 B";
  var units = ["B", "KiB", "MiB", "GiB", "TiB"];
  var index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return (value / Math.pow(1024, index)).toFixed(index ? 1 : 0) + " " + units[index];
}

function duration(seconds) {
  var days = Math.floor(seconds / 86400);
  var hours = Math.floor((seconds % 86400) / 3600);
  var minutes = Math.floor((seconds % 3600) / 60);
  if (days) return days + " 天 " + hours + " 小时";
  if (hours) return hours + " 小时 " + minutes + " 分";
  return minutes + " 分";
}

function setBar(id, percent) {
  var element = document.getElementById(id);
  element.className = "bar" + (percent >= 90 ? " crit" : percent >= 70 ? " warn" : "");
  element.firstElementChild.style.width = Math.min(100, percent) + "%";
}

function drawChart() {
  var canvas = document.getElementById("cpuchart");
  var ctx = canvas.getContext("2d");
  var w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (cpuHistory.length < 2) return;
  ctx.strokeStyle = "#4c8dff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (var i = 0; i < cpuHistory.length; i++) {
    var x = (i / (MAX_POINTS - 1)) * w;
    var y = h - (cpuHistory[i] / 100) * h;
    if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y);
  }
  ctx.stroke();
  ctx.lineTo(w, h); ctx.lineTo(0, h); ctx.closePath();
  ctx.fillStyle = "rgba(76,141,255,.12)";
  ctx.fill();
}

async function refresh() {
  try {
    var response = await fetch("api/metrics", { cache: "no-store" });
    var data = await response.json();

    document.getElementById("sub").textContent =
      "更新于 " + new Date(data.time).toLocaleTimeString("zh-CN") + " · 每秒刷新";

    var cpu = data.cpu.percent;
    cpuHistory.push(cpu);
    if (cpuHistory.length > MAX_POINTS) cpuHistory.shift();
    document.getElementById("cpu").textContent = cpu.toFixed(1) + "%";
    document.getElementById("cpumeta").textContent =
      data.cpu.cores + " 核 · 负载 " + data.cpu.load.one.toFixed(2) + " / " +
      data.cpu.load.five.toFixed(2) + " / " + data.cpu.load.fifteen.toFixed(2);
    setBar("cpubar", cpu);
    drawChart();

    var mem = data.memory;
    document.getElementById("mem").textContent = mem.percent.toFixed(1) + "%";
    document.getElementById("memmeta").textContent =
      bytes(mem.used) + " / " + bytes(mem.total) + " · 可用 " + bytes(mem.available);
    setBar("membar", mem.percent);

    document.getElementById("diskbody").innerHTML = data.disks.map(function (disk) {
      return "<div style='margin-bottom:10px'>" +
        "<div style='color:#e6e8ee'>" + disk.mount + " — " + disk.percent.toFixed(0) + "%</div>" +
        "<div class='bar" + (disk.percent >= 90 ? " crit" : disk.percent >= 70 ? " warn" : "") + "'><i style='width:" +
        Math.min(100, disk.percent) + "%'></i></div>" +
        "<div style='margin-top:4px'>" + bytes(disk.used) + " / " + bytes(disk.total) +
        " · 可用 " + bytes(disk.available) + "</div></div>";
    }).join("");

    document.getElementById("uptime").textContent = duration(data.uptime);
    document.getElementById("containers").textContent =
      data.containersRunning + " / " + data.containers.length + " 个容器运行中";

    document.getElementById("ctable").innerHTML = data.containers.length
      ? data.containers.map(function (c) {
          var running = c.state === "running";
          return "<tr><td><span class='dot" + (running ? "" : " off") + "'></span>" + c.name + "</td>" +
            "<td class='meta'>" + c.status + "</td>" +
            "<td class='num'>" + c.cpuPercent.toFixed(2) + "%</td>" +
            "<td class='num'>" + bytes(c.memUsed) + "</td></tr>";
        }).join("")
      : "<tr><td colspan='4' class='meta'>没有容器</td></tr>";
  } catch (error) {
    document.getElementById("sub").innerHTML = "<span class='err'>读取失败：" + error.message + "</span>";
  }
}

refresh();
setInterval(refresh, 1000);
</script>
</body>
</html>`;

server.listen(PORT, "0.0.0.0", () => {
  console.log("metrics panel listening on http://0.0.0.0:" + PORT);
});
