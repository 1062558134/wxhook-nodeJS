const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const { createCanvas, registerFont } = require("@napi-rs/canvas");

const app = express();

// 配置CORS中间件
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  // 处理预检请求
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// 配置body-parser，增加请求体大小限制
// 默认100kb太小，前端推送大量投注数据会超限
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));

// 数据保存文件
const DATA_FILE = path.join(__dirname, "WeChatMentions.json");
const OUTPUT_IMAGE_DIR = path.join(__dirname, "generated_outputs");

if (!fs.existsSync(OUTPUT_IMAGE_DIR)) {
  fs.mkdirSync(OUTPUT_IMAGE_DIR, { recursive: true });
}

app.use("/generated_outputs", express.static(OUTPUT_IMAGE_DIR));

// 字体注册（Windows 常用字体）
const WINDOWS_FONT_DIR = process.env.WINDIR ? path.join(process.env.WINDIR, "Fonts") : "C:/Windows/Fonts";
const FONT_CANDIDATES = [
  { file: "msyh.ttf", family: "Microsoft YaHei" },
  { file: "msyh.ttc", family: "Microsoft YaHei" },
  { file: "msyhbd.ttc", family: "Microsoft YaHei Bold", weight: "bold" },
  { file: "simhei.ttf", family: "SimHei" },
];

FONT_CANDIDATES.forEach((font) => {
  const fontPath = path.join(WINDOWS_FONT_DIR, font.file);
  if (fs.existsSync(fontPath)) {
    try {
      registerFont(fontPath, { family: font.family, weight: font.weight || "normal" });
    } catch (err) {
      console.warn("⚠️ 字体注册失败", fontPath, err.message);
    }
  }
});

function formatCurrency(value) {
  return `¥${Math.round(value).toLocaleString("zh-CN")}`;
}

function renderFundChartImage(fundData, options = {}) {
  const {
    title = "资金赔率图",
    subtitle = "",
    groupName = "",
    merged = false,
  } = options;

  const items = (fundData?.items || []).slice();
  if (!items.length) {
    throw new Error("资金图数据为空，无法生成图片");
  }

  const width = 960;
  const marginLeft = 200;
  const marginRight = 120;
  const marginTop = 190;
  const marginBottom = 140;
  const rowHeight = 64;
  const rowGap = 8;
  const totalRows = items.length;
  const tableHeight = totalRows * rowHeight + Math.max(0, (totalRows - 1) * rowGap);
  const height = marginTop + marginBottom + tableHeight;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#FFBC8C";
  ctx.fillRect(0, 0, width, height);

  const drawText = (text, x, y, { size = 20, color = "#1F2937", bold = false } = {}) => {
    const weight = bold ? "bold" : "normal";
    ctx.font = `${weight} ${size}px "Microsoft YaHei", "SimHei", sans-serif`;
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  };

  const drawRightText = (text, x, y, options) => {
    const { size = 20, color = "#1F2937", bold = false } = options || {};
    const weight = bold ? "bold" : "normal";
    ctx.font = `${weight} ${size}px "Microsoft YaHei", "SimHei", sans-serif`;
    const metrics = ctx.measureText(text);
    ctx.fillStyle = color;
    ctx.fillText(text, x - metrics.width, y);
  };

  const drawRoundedRect = (x, y, w, h, radius, fill) => {
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.lineTo(x + w - radius, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
    ctx.lineTo(x + w, y + h - radius);
    ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
    ctx.lineTo(x + radius, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
    ctx.lineTo(x, y + radius);
    ctx.quadraticCurveTo(x, y, x + radius, y);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
  };

  drawText(`${groupName} ${merged ? "合并" : ""}资金赔率图`.trim(), 40, 60, { size: 34, bold: true });
  if (subtitle) {
    drawText(subtitle, 40, 100, { size: 22, color: "#374151" });
  }

  const totalBet = fundData.totalBet || 0;
  const feeAmt = fundData.feeAmt || 0;
  const netPool = fundData.netPool || totalBet - feeAmt;

  drawText(
    `总押注：${formatCurrency(totalBet)}   代理费：${formatCurrency(feeAmt)}   净资金池：${formatCurrency(netPool)}`,
    40,
    140,
    { size: 20, color: "#4B5563" }
  );

  if (merged) {
    const agentNames = fundData.agentNames || [];
    if (agentNames.length) {
      const display = agentNames.slice(0, 5).join("、") + (agentNames.length > 5 ? ` 等${agentNames.length}个` : "");
      drawText(`包含代理：${display}`, 40, 170, { size: 18, color: "#4B5563" });
    }
  } else if (fundData.agentName) {
    drawText(`代理：${fundData.agentName}`, 40, 170, { size: 18, color: "#4B5563" });
  }

  const barAreaWidth = width - marginLeft - marginRight;
  const maxStake = Math.max(...items.map((item) => item.stake || 0), 1);

  const headerY = marginTop - 46;
  drawText("动物", 40, headerY, { size: 20, bold: true });
  drawText("押注分布", marginLeft, headerY, { size: 20, bold: true });
  drawRightText("输赢 (¥)", width - marginRight, headerY, { size: 20, bold: true });

  items.forEach((item, index) => {
    const topY = marginTop + index * (rowHeight + rowGap);
    const bottomY = topY + rowHeight;
    const bgColor = index % 2 === 0 ? "#FECBAA" : "#FDBA8C";
    drawRoundedRect(30, topY, width - 60, rowHeight, 18, bgColor);

    const stake = Math.max(item.stake || 0, 0);
    const payout = item.payout || stake * 27;
    const profit = item.profit || netPool - payout;

    drawText(item.animal || "-", 48, topY + 24, { size: 22, bold: true });
    drawText(
      `押注：${formatCurrency(stake)}  赔付：${formatCurrency(payout)}`,
      48,
      topY + 48,
      { size: 16, color: "#4B5563" }
    );

    const barLength = maxStake > 0 ? Math.max(6, Math.round((stake / maxStake) * (barAreaWidth - 20))) : 6;
    const barLeft = marginLeft;
    const barTop = topY + 18;
    const barHeight = rowHeight - 36;
    drawRoundedRect(barLeft, barTop, barLength, barHeight, 12, "#10B981");

    const profitColor = profit < 0 ? "#DC2626" : profit > 0 ? "#047857" : "#1F2937";
    const profitText = profit > 0 ? `+${formatCurrency(profit)}` : formatCurrency(profit);
    drawRightText(profitText, width - marginRight, topY + 34, { size: 22, bold: true, color: profitColor });
  });

  return canvas;
}

const SESSION_LABELS = {
  morning_0930: "第一场 09:30",
  noon_1130: "第二场 11:30",
  night_2330: "第三场 23:30",
};

function getSessionLabel(sessionKey) {
  if (!sessionKey) return "未知场次";
  return SESSION_LABELS[sessionKey] || sessionKey;
}

function safeFilenameBase(name) {
  if (!name) return "chart";
  return String(name).replace(/[\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").slice(0, 80) || "chart";
}

function saveCanvasToFile(canvas, prefix, nameHint = "chart") {
  const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const safeName = safeFilenameBase(nameHint);
  const filename = `${prefix}_${safeName}_${timestamp}.png`;
  const filepath = path.join(OUTPUT_IMAGE_DIR, filename);
  const buffer = canvas.toBuffer("image/png");
  fs.writeFileSync(filepath, buffer);
  return filepath;
}

function renderDailyReportImage(reportData, options = {}) {
  const {
    title = "每日三场账目表",
    subtitle = "",
    merged = false,
  } = options;

  const sessions = reportData.sessions || [];
  if (!sessions.length) {
    throw new Error("账目表数据为空，无法生成图片");
  }

  const width = 1120;
  const margin = 48;
  const rowHeight = 72;
  const headerHeight = 220;
  const footerHeight = 120;
  const totalRows = sessions.length + 2; // 合计 + 实际盈亏
  const height = headerHeight + footerHeight + totalRows * rowHeight;

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");

  ctx.fillStyle = "#FFFFFF";
  ctx.fillRect(0, 0, width, height);

  const setFont = (size = 20, bold = false) => {
    const weight = bold ? "bold" : "normal";
    ctx.font = `${weight} ${size}px "Microsoft YaHei", "SimHei", sans-serif`;
  };

  const drawText = (text, x, y, { size = 20, bold = false, color = "#1F2937", align = "left" } = {}) => {
    setFont(size, bold);
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = "top";
    ctx.fillText(text, x, y);
  };

  const drawCenteredText = (text, x0, y0, x1, y1, options = {}) => {
    const { size = 20, bold = false, color = "#1F2937" } = options;
    setFont(size, bold);
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, (x0 + x1) / 2, (y0 + y1) / 2);
  };

  const drawRowBackground = (x0, y0, x1, y1, color) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y0);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x0, y1);
    ctx.closePath();
    ctx.fill();
  };

  drawText(title, margin, margin, { size: 34, bold: true });
  if (subtitle) {
    drawText(subtitle, margin, margin + 46, { size: 24, color: "#374151" });
  }

  const feeLine = `代理费率：${reportData.agentFeePercent ?? "-"}%`;
  drawText(feeLine, margin, margin + 90, { size: 22, color: "#4B5563" });

  if (merged) {
    const agents = reportData.agentNames || [];
    if (agents.length) {
      const displayAgents = agents.slice(0, 6).join("、") + (agents.length > 6 ? ` 等${agents.length}个` : "");
      drawText(`合并代理：${displayAgents}`, margin, margin + 122, { size: 20, color: "#4B5563" });
    }
  } else if (reportData.agentName) {
    drawText(`代理：${reportData.agentName}`, margin, margin + 122, { size: 20, color: "#4B5563" });
  }

  const columns = [
    { key: "session", label: "场次", width: 130 },
    { key: "winner", label: "开宝", width: 150 },
    { key: "totalBet", label: "总押注", width: 170 },
    { key: "winnerStake", label: "中宝押注", width: 170 },
    { key: "feeAmt", label: "代理费", width: 170 },
    { key: "winnerPayout", label: "中宝赔付", width: 170 },
    { key: "profit", label: "输赢", width: 170 },
  ];

  const tableLeft = margin;
  const tableTop = margin + 170;
  const tableRight = width - margin;
  const headerBottom = tableTop + rowHeight;

  ctx.fillStyle = "#E5F4FF";
  ctx.fillRect(tableLeft, tableTop, tableRight - tableLeft, rowHeight);

  let currentX = tableLeft;
  columns.forEach((col) => {
    drawCenteredText(col.label, currentX, tableTop, currentX + col.width, headerBottom, { size: 20, bold: true });
    currentX += col.width;
  });

  let rowY = headerBottom;
  const totals = reportData.totals || {};

  sessions.forEach((session, index) => {
    const rowTop = rowY;
    const rowBottom = rowTop + rowHeight;
    const isEven = index % 2 === 0;
    drawRowBackground(tableLeft, rowTop, tableRight, rowBottom, isEven ? "#FFFFFF" : "#F3F4F6");

    const winner = session.winner || "未设置";
    const totalBet = session.totalBet || 0;
    const feeAmt = session.feeAmt || 0;
    const winnerStake = session.sessionPool && winner && session.sessionPool[winner] ? session.sessionPool[winner] : 0;
    const winnerPayout = winnerStake * 27;
    const profitValue = winner ? totalBet - feeAmt - winnerPayout : (session.minProfit ?? totalBet - feeAmt);

    const rowValues = [
      getSessionLabel(session.sessionKey),
      winner,
      formatCurrency(totalBet),
      formatCurrency(winnerStake),
      formatCurrency(feeAmt),
      formatCurrency(winnerPayout),
      formatCurrency(profitValue),
    ];

    currentX = tableLeft;
    rowValues.forEach((text, idx) => {
      const col = columns[idx];
      const color = idx === rowValues.length - 1 && profitValue < 0 ? "#DC2626" : "#1F2937";
      drawCenteredText(text, currentX, rowTop, currentX + col.width, rowBottom, { size: 18, bold: idx === 0, color });
      currentX += col.width;
    });

    rowY += rowHeight;
  });

  // 合计行
  const totalRowTop = rowY;
  const totalRowBottom = totalRowTop + rowHeight;
  drawRowBackground(tableLeft, totalRowTop, tableRight, totalRowBottom, "#EDE9FE");

  const totalValues = [
    "合计",
    "/",
    formatCurrency(totals.totalBet || 0),
    formatCurrency(0),
    formatCurrency(totals.totalFee || 0),
    formatCurrency(0),
    formatCurrency(totals.minProfit || 0),
  ];

  let idx = 0;
  currentX = tableLeft;
  totalValues.forEach((text) => {
    const col = columns[idx];
    const profitColor = idx === totalValues.length - 1 && (totals.minProfit || 0) < 0 ? "#DC2626" : "#1F2937";
    drawCenteredText(text, currentX, totalRowTop, currentX + col.width, totalRowBottom, { size: 18, bold: true, color: profitColor });
    currentX += col.width;
    idx += 1;
  });

  // 实际盈亏
  rowY += rowHeight;
  const finalRowTop = rowY;
  const finalRowBottom = finalRowTop + rowHeight;
  drawRowBackground(tableLeft, finalRowTop, tableRight, finalRowBottom, "#FFFFFF");

  const finalProfit = totals.minProfit || 0;
  drawCenteredText("实际盈亏", tableLeft, finalRowTop, tableLeft + columns[0].width, finalRowBottom, { size: 18, bold: true });
  drawCenteredText(formatCurrency(finalProfit), tableRight - columns[columns.length - 1].width, finalRowTop, tableRight, finalRowBottom, {
    size: 18,
    bold: true,
    color: finalProfit < 0 ? "#DC2626" : "#047857",
  });

  // Footer 提示
  const footerY = headerHeight + sessions.length * rowHeight + rowHeight;
  if (finalProfit < 0) {
    drawText("⚠️ 当前存在亏损，请关注中宝赔付与代理费率设置。", margin, footerY + 20, { size: 18, color: "#DC2626" });
  }

  return canvas;
}

// 从文件读取历史记录（兼容旧版本）
function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, "utf8");
      return JSON.parse(raw);
    }
  } catch (err) {
    console.error("读取数据文件失败：", err);
  }
  return [];
}

// 保存数据到文件（兼容旧版本）
function saveData(dataList) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(dataList, null, 2), "utf8");
}

// ✅ 新增：从群名（chat_name）提取代理名
function extractAgentNameFromChat(chatName) {
  if (!chatName) return null;
  // 群名应该就是代理名，直接返回（去除首尾空格）
  return chatName.trim();
}

// 从前端获取真实数据生成资金赔率图
function generateFundChartData() {
  try {
    // 尝试从前端API获取真实数据
    const frontendData = getFrontendData();
    if (frontendData && frontendData.state && frontendData.state.bets) {
      console.log("✅ 使用前端真实数据");
      return calculateFundChartFromRealData(frontendData);
    }
  } catch (error) {
    console.log('❌ 无法获取前端数据，使用模拟数据:', error.message);
  }
  
  // 回退到模拟数据
  console.log("🔄 使用模拟数据生成图表");
  return generateMockFundChartData();
}

// 存储前端数据
let frontendStateData = null;

// 从前端获取数据
function getFrontendData() {
  console.log('🔍 检查前端数据:', frontendStateData ? '有数据' : '无数据');
  if (frontendStateData) {
    console.log('📊 前端数据概览:', {
      hasState: !!frontendStateData.state,
      dateStr: frontendStateData.dateStr,
      sessionKey: frontendStateData.sessionKey,
      selectedAgentIds: frontendStateData.selectedAgentIds,
      agentFeePercent: frontendStateData.agentFeePercent,
      dailyFeeByAgent: frontendStateData.state?.dailyFeeByAgent,
      chartFeeByAgent: frontendStateData.state?.chartFeeByAgent
    });
  }
  return frontendStateData;
}

// 从真实数据计算资金赔率图
function calculateFundChartFromRealData(frontendData) {
  const { state, dateStr, sessionKey, selectedAgentIds, agentFeePercent } = frontendData;
  
  console.log('📊 开始计算资金赔率图:', { dateStr, sessionKey, selectedAgentIds, agentFeePercent });
  
  // 模拟前端的计算逻辑
  const day = state.bets[dateStr] || {};
  console.log('📅 当日数据:', Object.keys(day));
  
  // 计算合并池（多个代理的数据合并）
  let chartSessionPool = {};
  if (selectedAgentIds && selectedAgentIds.length > 0) {
    const merged = {};
    for (const aid of selectedAgentIds) {
      const perAgent = (day[aid] || {})[sessionKey];
      if (!perAgent) continue;
      for (const [animal, amt] of Object.entries(perAgent)) {
        merged[animal] = (merged[animal] || 0) + (amt || 0);
      }
    }
    chartSessionPool = merged;
  } else {
    // 如果没有选择代理，使用当前代理的数据
    const agentId = Object.keys(day)[0]; // 使用第一个代理
    chartSessionPool = (day[agentId] || {})[sessionKey] || {};
  }
  
  console.log('🎯 合并池数据:', chartSessionPool);
  
  // 计算资金赔率图数据
  const animalsList = state.animals.length > 0 ? state.animals : Object.keys(chartSessionPool);
  const totalBet = Object.values(chartSessionPool).reduce((a, b) => a + (b || 0), 0);
  const feeAmt = totalBet * (agentFeePercent / 100);
  const netPool = totalBet - feeAmt;
  
  console.log('💰 计算结果:', { totalBet, feeAmt, netPool, animalsList });
  
  const items = animalsList.map(animal => {
    const stake = chartSessionPool[animal] || 0;
    const payout = stake * 27;
    const profit = netPool - payout;
    return { animal, stake, payout, profit };
  });
  
  // 按利润从高到低排序
  items.sort((a, b) => b.profit - a.profit);
  
  console.log('📈 最终项目:', items);
  
  return {
    items,
    totalBet,
    feeAmt,
    netPool,
    min: Math.min(...items.map(item => item.profit)),
    max: Math.max(...items.map(item => item.profit))
  };
}

// 生成个性化资金赔率图数据
function generatePersonalizedFundChartData(agentIds) {
  console.log("🎯 生成个性化资金赔率图数据，代理IDs:", agentIds);
  
  try {
    // 尝试从前端获取真实数据
    const frontendData = getFrontendData();
    if (frontendData && frontendData.state && frontendData.state.bets) {
      return calculatePersonalizedFundChartFromRealData(frontendData, agentIds);
    }
  } catch (error) {
    console.log('❌ 无法获取前端个性化数据，使用模拟数据:', error.message);
  }
  
  // 回退到模拟数据
  return generateMockFundChartData();
}

// 从真实数据计算个性化资金赔率图
function calculatePersonalizedFundChartFromRealData(frontendData, agentIds) {
  const { state, dateStr, sessionKey, agentFeePercent } = frontendData;
  
  console.log('📊 开始计算个性化资金赔率图:', { dateStr, sessionKey, agentIds });
  
  // 模拟前端的计算逻辑
  const day = state.bets[dateStr] || {};
  console.log('📅 当日数据:', Object.keys(day));
  
  // 计算指定代理的合并池
  const merged = {};
  for (const aid of agentIds) {
    const perAgent = (day[aid] || {})[sessionKey];
    if (!perAgent) continue;
    for (const [animal, amt] of Object.entries(perAgent)) {
      merged[animal] = (merged[animal] || 0) + (amt || 0);
    }
  }
  
  console.log('🎯 指定代理合并池数据:', merged);
  
  // 计算资金赔率图数据
  const animalsList = state.animals.length > 0 ? state.animals : Object.keys(merged);
  const totalBet = Object.values(merged).reduce((a, b) => a + (b || 0), 0);
  const feeAmt = totalBet * (agentFeePercent / 100);
  const netPool = totalBet - feeAmt;
  
  console.log('💰 个性化计算结果:', { totalBet, feeAmt, netPool, animalsList });
  
  const items = animalsList.map(animal => {
    const stake = merged[animal] || 0;
    const payout = stake * 27;
    const profit = netPool - payout;
    return { animal, stake, payout, profit };
  });
  
  // 按利润从高到低排序
  items.sort((a, b) => b.profit - a.profit);
  
  console.log('📈 个性化最终项目:', items);
  
  return {
    items,
    totalBet,
    feeAmt,
    netPool,
    min: Math.min(...items.map(item => item.profit)),
    max: Math.max(...items.map(item => item.profit)),
    agentIds: agentIds
  };
}

// 根据群聊名称计算资金赔率图（群名=代理名，直接查找对应代理）
function calculateFundChartByGroup(groupName, dateStr, sessionKey, agentFeePercent = null) {
  console.log('🎯 根据群聊名称（代理名）计算资金赔率图:', { groupName, dateStr, sessionKey, agentFeePercent });
  
  const frontendData = getFrontendData();
  if (!frontendData || !frontendData.state) {
    console.log('❌ 无前端数据，无法生成图表');
    console.log('💡 提示：请在前端点击"同步选中代理到机器人"按钮');
    return null;
  }
  
  const { state } = frontendData;
  
  // 1. 查找对应的代理（群名=代理名）
  const agents = state.agents || [];
  const targetAgent = agents.find(a => a.name === groupName);
  
  if (!targetAgent) {
    console.log('❌ 未找到代理:', groupName);
    console.log('📋 当前已配置的代理:', agents.map(a => a.name).join(', ') || '无');
    console.log('💡 提示：请确保群聊名称与前端配置的代理名称完全一致');
    return null;
  }
  
  console.log('✅ 找到代理:', targetAgent);
  const agentId = targetAgent.id;
  
  // 🔥 费率优先级逻辑（与每日三场表保持一致）
  // 优先级：请求参数 > chartFeeByAgent[场次][代理] > dailyFeeByAgent[代理] > targetAgent.feePercent > 默认16
  const feePercent = agentFeePercent || 
                     state.chartFeeByAgent?.[sessionKey]?.[agentId] ||
                     state.dailyFeeByAgent?.[agentId] || 
                     targetAgent.feePercent || 
                     16;
  
  console.log('💰 费率计算（与每日三场表逻辑一致）:', {
    agent_fee_percent: agentFeePercent,
    chartFeeByAgent: state.chartFeeByAgent?.[sessionKey]?.[agentId],
    dailyFeeByAgent: state.dailyFeeByAgent?.[agentId],
    targetAgentFeePercent: targetAgent.feePercent,
    finalFeePercent: feePercent
  });
  
  // 2. 获取该代理的投注数据
  const day = state.bets[dateStr] || {};
  console.log(`📅 查询日期 ${dateStr} 的投注数据:`, Object.keys(day).length > 0 ? `找到 ${Object.keys(day).length} 个代理的数据` : '没有数据');
  
  const agentData = day[agentId];
  console.log(`  检查代理 ${agentId} (${groupName}):`, agentData ? `有数据，场次: ${Object.keys(agentData).join(', ')}` : '无数据');
  
  let sessionPool = (agentData || {})[sessionKey] || {};
  let actualSessionKey = sessionKey;
  
  // 如果指定场次没有数据，尝试查找该代理今日有数据的最新场次
  if (Object.keys(sessionPool).length === 0 && agentData) {
    const availableSessions = Object.keys(agentData);
    console.log(`    ⚠️ 代理 ${groupName} 在场次 ${sessionKey} 没有投注数据`);
    console.log('    🔍 可用的场次:', availableSessions.join(', ') || '无');
    
    if (availableSessions.length > 0) {
      // 按时间顺序查找最新的有数据场次
      const sessionOrder = ['night_2330', 'noon_1130', 'morning_0930'];
      for (const session of sessionOrder) {
        if (availableSessions.includes(session) && Object.keys(agentData[session]).length > 0) {
          actualSessionKey = session;
          sessionPool = agentData[session];
          console.log(`    ✅ 自动切换到有数据的场次: ${actualSessionKey}`);
          break;
        }
      }
    }
    
    // 如果还是没有数据
    if (Object.keys(sessionPool).length === 0) {
      console.log('    ❌ 该代理今日所有场次都没有投注数据');
      console.log(`    💡 提示：请在前端为代理"${groupName}"添加投注数据`);
      return null;
    }
  }
  
  console.log(`    ✅ 代理 ${groupName} 在场次 ${actualSessionKey} 有投注:`, Object.keys(sessionPool).length, '个动物');
  console.log('📊 投注数据:', sessionPool);
  
  // 3. 计算资金赔率图
  const animalsList = state.animals.length > 0 ? state.animals : Object.keys(sessionPool);
  const totalBet = Object.values(sessionPool).reduce((a, b) => a + (b || 0), 0);
  
  console.log('💰 总投注额:', totalBet);
  
  if (totalBet === 0) {
    console.log('⚠️ 总投注额为0，无法生成图表');
    return null;
  }
  
  const feeAmt = totalBet * (feePercent / 100);
  const netPool = totalBet - feeAmt;
  
  const items = animalsList.map(animal => {
    const stake = sessionPool[animal] || 0;
    const payout = stake * 27;
    const profit = netPool - payout;
    return { animal, stake, payout, profit };
  });
  
  // 按利润从低到高排序（亏损的排前面）
  items.sort((a, b) => a.profit - b.profit);
  
  console.log('✅ 资金赔率图数据计算完成:', {
    totalBet,
    feeAmt,
    netPool,
    feePercent: feePercent,
    itemsCount: items.length
  });
  
  return {
    items,
    totalBet,
    feeAmt,
    netPool,
    agentName: groupName,
    agentId: agentId,
    agentFeePercent: feePercent,  // 使用计算后的费率
    dateStr,
    sessionKey: actualSessionKey,  // 返回实际使用的场次
    min: Math.min(...items.map(item => item.profit)),
    max: Math.max(...items.map(item => item.profit))
  };
}

// 生成模拟数据（备用）
function generateMockFundChartData() {
  console.log("🎲 生成模拟资金赔率图数据");
  const animals = ['白兔', '猴', '龙', '虎', '蛇', '马', '羊', '鸡', '狗', '猪', '牛', '鼠'];
  const items = animals.map(animal => {
    const stake = Math.floor(Math.random() * 2000) + 200;
    const payout = stake * 27;
    return { animal, stake, payout };
  });
  
  const totalBet = items.reduce((sum, item) => sum + item.stake, 0);
  const feeAmt = Math.floor(totalBet * 0.16);
  const netPool = totalBet - feeAmt;
  
  const itemsWithProfit = items.map(item => ({
    ...item,
    profit: netPool - item.payout
  }));
  
  console.log("📊 模拟数据生成完成:", {
    totalBet,
    feeAmt,
    netPool,
    itemsCount: itemsWithProfit.length
  });
  
  return {
    items: itemsWithProfit,
    totalBet,
    feeAmt,
    netPool,
    min: Math.min(...itemsWithProfit.map(item => item.profit)),
    max: Math.max(...itemsWithProfit.map(item => item.profit))
  };
}

// ✅ 接收微信@消息
app.post("/api/wechat_mentions", (req, res) => {
  const data = req.body;
  console.log("📥 收到微信@消息上报：", data);

  // 读取已有数据，追加新的一条
  const allData = readData();
  allData.push({
    ...data,
    received_at: new Date().toLocaleString(),
  });
  saveData(allData);

  res.send({ ok: true, total: allData.length });
});

// ✅ 获取所有消息（浏览器可直接访问，兼容旧版本）
app.get("/api/data", (req, res) => {
  // 支持limit参数，默认返回所有
  const limit = req.query.limit ? parseInt(req.query.limit) : null;
  
  // 优先返回存储的微信消息
  if (global.wechatMessages && global.wechatMessages.length > 0) {
    console.log("📱 返回微信消息数据:", global.wechatMessages.length, "条");
    const data = limit ? global.wechatMessages.slice(-limit).reverse() : global.wechatMessages.slice().reverse();
    res.json({
      total: global.wechatMessages.length,
      data: data,
    });
  } else {
    // 如果没有微信消息，返回文件中的数据
    const allData = readData();
    console.log("📁 返回文件数据:", allData.length, "条");
    const data = limit ? allData.slice(-limit).reverse() : allData.slice().reverse();
    
    res.json({
      total: allData.length,
      data: data,
    });
  }
});

// ✅ 新增：按代理名获取消息（推荐使用）
app.get("/api/data/:agentName", (req, res) => {
  try {
    const agentName = decodeURIComponent(req.params.agentName);
    const limit = req.query.limit ? parseInt(req.query.limit) : null;

    console.log(`📋 收到获取代理 "${agentName}" 数据的请求`);

    let filteredData = [];
    if (global.wechatMessages && global.wechatMessages.length > 0) {
      filteredData = global.wechatMessages.filter(msg => {
        const msgChatName = msg.data?.chat_name || '';
        return extractAgentNameFromChat(msgChatName) === agentName;
      });
    } else {
      const allData = readData();
      filteredData = allData.filter(msg => {
        const msgChatName = msg.data?.chat_name || msg.chat_name || '';
        return extractAgentNameFromChat(msgChatName) === agentName;
      });
    }

    console.log(`📊 为代理 "${agentName}" 找到 ${filteredData.length} 条数据`);

    const data = limit ? filteredData.slice(-limit).reverse() : filteredData.slice().reverse();
    res.json({
      success: true,
      total: filteredData.length,
      agent_name: agentName,
      data: data,
      note: filteredData.length > 0 ? "数据来自全局存储" : "该代理暂无数据"
    });
  } catch (error) {
    console.error("❌ 获取代理数据失败:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      agent_name: req.params.agentName
    });
  }
});

// ✅ 清空数据
app.get("/api/clear", (req, res) => {
  // 清空文件数据
  saveData([]);
  
  // 清空内存中的微信消息数据
  if (global.wechatMessages) {
    global.wechatMessages = [];
  }
  
  // 清空前端状态数据
  frontendStateData = null;
  
  console.log("🗑️ 已清空所有数据（文件和内存）");
  res.json({ 
    ok: true, 
    message: "所有数据已清空（包括文件和内存中的数据）",
    timestamp: new Date().toISOString()
  });
});

// ✅ 新增：清空指定代理的数据
app.delete("/api/data/:agentName", (req, res) => {
  try {
    const agentName = decodeURIComponent(req.params.agentName);

    // 从全局内存中移除该代理的数据
    if (global.wechatMessages && global.wechatMessages.length > 0) {
      global.wechatMessages = global.wechatMessages.filter(msg => {
        const msgChatName = msg.data?.chat_name || '';
        return extractAgentNameFromChat(msgChatName) !== agentName;
      });
    }
    
    console.log(`🗑️ 已清空代理 "${agentName}" 的数据`);
    res.json({
      success: true,
      message: `已清空代理 "${agentName}" 的数据`,
      agent_name: agentName,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error("❌ 清空代理数据失败:", error);
    res.status(500).json({
      success: false,
      error: error.message,
      agent_name: req.params.agentName
    });
  }
});

// ✅ 健康检查接口
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    message: "服务器运行正常",
    timestamp: new Date().toISOString()
  });
});

// ✅ 获取前端状态数据（GET方法）
app.get("/api/frontend-state", (req, res) => {
  try {
    if (frontendStateData) {
      res.json(frontendStateData);
    } else {
      res.status(404).json({
        success: false,
        message: "前端数据未同步",
        hint: "请确保前端应用正在运行并已推送数据"
      });
    }
  } catch (error) {
    console.error('❌ 获取前端状态失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ 接收前端状态数据（POST方法）
app.post("/api/frontend-state", (req, res) => {
  try {
    frontendStateData = req.body;
    console.log("📊 收到前端状态数据");
    console.log("📊 数据详情:", {
      hasState: !!frontendStateData.state,
      hasBets: !!frontendStateData.state?.bets,
      dateStr: frontendStateData.dateStr,
      sessionKey: frontendStateData.sessionKey,
      selectedAgentIds: frontendStateData.selectedAgentIds,
      agentFeePercent: frontendStateData.agentFeePercent,
      agentsCount: frontendStateData.state?.agents?.length || 0,
      groupsCount: frontendStateData.state?.groups?.length || 0,
      dailyFeeByAgent: frontendStateData.state?.dailyFeeByAgent || {},
      chartFeeByAgent: frontendStateData.state?.chartFeeByAgent || {},
      hasWinners: !!frontendStateData.state?.winners
    });
    
    if (frontendStateData.state?.bets) {
      const betsKeys = Object.keys(frontendStateData.state.bets);
      console.log("📊 投注数据日期:", betsKeys);
      if (betsKeys.length > 0) {
        const firstDate = betsKeys[0];
        const firstDateData = frontendStateData.state.bets[firstDate];
        console.log("📊 第一个日期的代理:", Object.keys(firstDateData));
      }
    }
    
    if (frontendStateData.state?.groups) {
      console.log("📊 群组配置:", frontendStateData.state.groups.map(g => ({
        name: g.name,
        agentCount: g.agentIds?.length || 0
      })));
    }
    
    res.json({
      success: true,
      message: "前端状态数据已更新"
    });
  } catch (error) {
    console.log("❌ 接收前端数据失败:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ 资金赔率图数据API - 支持个性化请求
app.get("/api/fund-chart-data", (req, res) => {
  try {
    const fundData = generateFundChartData();
    res.json({
      success: true,
      data: fundData,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ 个性化资金赔率图数据API
app.post("/api/fund-chart-data", (req, res) => {
  try {
    const { agent_ids, action } = req.body;
    
    if (action === 'get_fund_chart' && agent_ids && Array.isArray(agent_ids)) {
      // 生成指定代理的数据
      const fundData = generatePersonalizedFundChartData(agent_ids);
      res.json({
        success: true,
        data: fundData,
        agent_ids: agent_ids,
        timestamp: new Date().toISOString()
      });
    } else {
      // 默认行为
      const fundData = generateFundChartData();
      res.json({
        success: true,
        data: fundData,
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ 新增：根据群聊名称生成资金赔率图（用于机器人自动发图）
app.post("/api/fund-chart-by-group", (req, res) => {
  try {
    const { group_name, date_str, session_key, agent_fee_percent } = req.body;
    
    console.log('📥 收到资金赔率图请求:', { group_name, date_str, session_key, agent_fee_percent });
    
    if (!group_name) {
      return res.status(400).json({
        success: false,
        error: '缺少群聊名称参数 group_name'
      });
    }
    
    // 使用当前日期和默认场次（如果未提供）
    const today = new Date();
    const dateStr = date_str || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    
    // 根据当前时间判断默认场次
    const hour = today.getHours();
    let sessionKey = session_key;
    if (!sessionKey) {
      if (hour < 9) {
        sessionKey = 'morning_0930';
      } else if (hour < 11) {
        sessionKey = 'noon_1130';
      } else {
        sessionKey = 'night_2330';
      }
    }
    
    // 🔥 不再强制默认值，让calculateFundChartByGroup函数内部根据前端配置自动计算费率
    // 只有在请求中明确传递了agent_fee_percent时才使用
    const fundData = calculateFundChartByGroup(group_name, dateStr, sessionKey, agent_fee_percent);
    
    if (!fundData) {
      // 获取前端数据以提供更详细的错误信息
      const frontendData = getFrontendData();
      const agents = frontendData?.state?.agents || [];
      const agentExists = agents.some(a => a.name === group_name);
      
      let errorMsg = '无法生成资金赔率图';
      let suggestions = [];
      
      if (!frontendData || !frontendData.state) {
        errorMsg += '：前端数据未同步';
        suggestions.push('请在前端点击"同步选中代理到机器人"按钮');
      } else if (!agentExists) {
        errorMsg += `：未找到代理"${group_name}"`;
        suggestions.push('请确保群聊名称与前端配置的代理名称完全一致');
        if (agents.length > 0) {
          suggestions.push(`当前已配置的代理：${agents.map(a => a.name).join('、')}`);
        }
      } else {
        errorMsg += `：代理"${group_name}"没有投注数据`;
        suggestions.push(`请在前端为代理"${group_name}"添加投注数据`);
        suggestions.push(`场次：${session_key || '当前场次'}`);
      }
      
      return res.status(404).json({
        success: false,
        error: errorMsg,
        group_name: group_name,
        suggestions: suggestions
      });
    }
    
    res.json({
      success: true,
      data: fundData,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ 生成资金赔率图失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ 新增：纯数据同步接口（不影响监听器，用于频繁更新资金图数据）
app.post("/api/sync-chart-data", (req, res) => {
  try {
    const requestData = req.body;
    
    console.log('📊 收到资金图数据同步请求');
    
    // 直接更新前端状态数据（不写入config.json，不重启监听器）
    frontendStateData = requestData;
    
    console.log('✅ 资金图数据已更新（实时生效）');
    console.log('📊 数据概览:', {
      hasState: !!frontendStateData.state,
      dateStr: frontendStateData.dateStr,
      sessionKey: frontendStateData.sessionKey,
      selectedAgentIds: frontendStateData.selectedAgentIds,
      agentsCount: frontendStateData.state?.agents?.length || 0,
      groupsCount: frontendStateData.state?.groups?.length || 0
    });
    
    res.json({
      success: true,
      message: '✅ 资金图数据已更新\n\n📊 图表功能可立即使用\n💬 不影响消息监听',
      realtime_ready: true
    });
    
  } catch (error) {
    console.log("❌ 同步资金图数据失败:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ 新增：根据群聊名称生成多代理合并的资金赔率图
app.post("/api/fund-chart-by-group-merged", (req, res) => {
  try {
    const { group_name, date_str, session_key, agent_fee_percent } = req.body;
    
    console.log('📥 收到多代理合并资金赔率图请求:', { group_name, date_str, session_key, agent_fee_percent });
    
    if (!group_name) {
      return res.status(400).json({
        success: false,
        error: '缺少群聊名称参数 group_name'
      });
    }
    
    const frontendData = getFrontendData();
    if (!frontendData || !frontendData.state) {
      console.log('❌ 无前端数据，无法生成图表');
      return res.status(404).json({
        success: false,
        error: '前端数据未同步',
        hint: '请在前端点击"同步选中代理到机器人"按钮'
      });
    }
    
    const { state } = frontendData;
    
    // 1. 查找对应的群组
    const groups = state.groups || [];
    const targetGroup = groups.find(g => g.name === group_name);
    
    if (!targetGroup) {
      console.log('❌ 未找到群组:', group_name);
      console.log('📋 当前已配置的群组:', groups.map(g => g.name).join(', ') || '无');
      return res.status(404).json({
        success: false,
        error: `未找到群组"${group_name}"`,
        hint: '请确保群聊名称与前端配置的群组名称完全一致',
        availableGroups: groups.map(g => g.name)
      });
    }
    
    const agentIds = targetGroup.agentIds || [];
    console.log(`✅ 找到群组: ${group_name}, 关联代理数: ${agentIds.length}`);
    
    if (agentIds.length === 0) {
      console.log('⚠️ 该群组没有关联任何代理');
      return res.status(404).json({
        success: false,
        error: `群组"${group_name}"没有关联任何代理`,
        hint: '请在前端为该群组添加代理'
      });
    }
    
    // 2. 获取日期和场次
    const today = new Date();
    // 前端同步的日期/场次优先，其次请求体，最后自动推断
    const frontendDateStr = frontendData.dateStr;
    const frontendSessionKey = frontendData.sessionKey;
    const dateStr = frontendDateStr || date_str || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    
    const hour = today.getHours();
    let sessionKey = frontendSessionKey || session_key;
    if (!sessionKey) {
      // 优先根据当前时间推断
      if (hour < 9) {
        sessionKey = 'morning_0930';
      } else if (hour < 11) {
        sessionKey = 'noon_1130';
      } else {
        sessionKey = 'night_2330';
      }
      
      // 如果推断的场次无数据，自动选择当日第一个有数据的场次
      try {
        const day = (state.bets && state.bets[dateStr]) || {};
        const candidateSessions = ['morning_0930', 'noon_1130', 'night_2330'];
        const hasDataForSession = (sess) => {
          for (const agentId of agentIds) {
            const agentData = day[agentId];
            if (agentData && agentData[sess]) {
              // 任意一个代理该场次有数据则认为该场次可用
              return true;
            }
          }
          return false;
        };
        if (!hasDataForSession(sessionKey)) {
          const found = candidateSessions.find(s => hasDataForSession(s));
          if (found) {
            console.log(`ℹ️ 自动选择有数据的场次: ${found}（原推断: ${sessionKey}）`);
            sessionKey = found;
          }
        }
      } catch (e) {
        console.log('⚠️ 自动选择场次时出错，使用默认推断场次:', e?.message || e);
      }
    }
    
    // 3. 合并多个代理的投注数据
    const day = state.bets[dateStr] || {};
    const merged = {};
    const agents = state.agents || [];
    let agentNames = [];
    const validAgentIds = [];
    
    for (const agentId of agentIds) {
      const agentData = day[agentId];
      if (!agentData) {
        console.log(`  ⚠️ 代理 ${agentId} 在 ${dateStr} 没有数据`);
        continue;
      }
      
      const sessionPool = agentData[sessionKey];
      if (!sessionPool) {
        console.log(`  ⚠️ 代理 ${agentId} 在场次 ${sessionKey} 没有数据`);
        continue;
      }
      
      validAgentIds.push(agentId);
      console.log(`  ✅ 代理 ${agentId} 有投注数据`);
      
      // 合并投注数据
      for (const [animal, amt] of Object.entries(sessionPool)) {
        merged[animal] = (merged[animal] || 0) + (amt || 0);
      }
    }
    
    if (validAgentIds.length === 0) {
      console.log('❌ 群组关联的所有代理在该场次都没有投注数据');
      return res.status(404).json({
        success: false,
        error: `群组"${group_name}"关联的代理在${sessionKey}场次没有投注数据`,
        hint: '请在前端为关联的代理添加投注数据',
        agentIds: agentIds
      });
    }
    
    console.log(`🎯 成功合并 ${validAgentIds.length} 个代理的数据`);
    console.log('📊 合并后的投注数据:', merged);
    
    // 4. 计算费率（使用群组或第一个代理的费率）
    // 优先级：请求参数 > chartFeeByAgent[场次][第一个代理] > dailyFeeByAgent[第一个代理] > 第一个代理默认费率 > 默认16
    const firstAgentId = validAgentIds[0];
    const firstAgent = agents.find(a => a.id === firstAgentId);
    
    const feePercent = agent_fee_percent || 
                       state.chartFeeByAgent?.[sessionKey]?.[firstAgentId] ||
                       state.dailyFeeByAgent?.[firstAgentId] || 
                       firstAgent?.feePercent || 
                       16;
    
    console.log('💰 费率计算:', {
      agent_fee_percent: agent_fee_percent,
      chartFeeByAgent: state.chartFeeByAgent?.[sessionKey]?.[firstAgentId],
      dailyFeeByAgent: state.dailyFeeByAgent?.[firstAgentId],
      firstAgentFeePercent: firstAgent?.feePercent,
      finalFeePercent: feePercent
    });
    
    // 5. 计算资金赔率图
    const animalsList = state.animals.length > 0 ? state.animals : Object.keys(merged);
    const totalBet = Object.values(merged).reduce((a, b) => a + (b || 0), 0);
    
    if (totalBet === 0) {
      console.log('⚠️ 总投注额为0，无法生成图表');
      return res.status(404).json({
        success: false,
        error: '总投注额为0'
      });
    }
    
    const feeAmt = totalBet * (feePercent / 100);
    const netPool = totalBet - feeAmt;
    
    const items = animalsList.map(animal => {
      const stake = merged[animal] || 0;
      const payout = stake * 27;
      const profit = netPool - payout;
      return { animal, stake, payout, profit };
    });
    
    // 按利润从低到高排序（亏损的排前面）
    items.sort((a, b) => a.profit - b.profit);
    
    console.log('✅ 多代理合并资金赔率图数据计算完成:', {
      totalBet,
      feeAmt,
      netPool,
      feePercent: feePercent,
      itemsCount: items.length,
      mergedAgentsCount: validAgentIds.length
    });
    
    agentNames = validAgentIds.map(id => {
      const agent = agents.find(a => a.id === id);
      return agent ? agent.name : id;
    });
    
    const fundData = {
      items,
      totalBet,
      feeAmt,
      netPool,
      groupName: group_name,
      agentIds: validAgentIds,
      agentNames: agentNames,
      agentFeePercent: feePercent,
      dateStr,
      sessionKey: sessionKey,
      min: Math.min(...items.map(item => item.profit)),
      max: Math.max(...items.map(item => item.profit))
    };

    const format = (req.query.format || req.body?.format || "json").toString().toLowerCase();

    if (format === "image") {
      try {
        const subtitle = `日期：${fundData.dateStr} | 场次：${getSessionLabel(fundData.sessionKey)}`;
        const canvas = renderFundChartImage(fundData, {
          title: `${group_name} 合并资金赔率图`,
          subtitle,
          groupName: group_name,
          merged: true,
        });
        const filepath = saveCanvasToFile(canvas, "fund_chart_merged", group_name);
        const imageUrl = `/generated_outputs/${path.basename(filepath)}`;

        return res.json({
          success: true,
          image_path: filepath,
          image_url: imageUrl,
          data: fundData,
          timestamp: new Date().toISOString(),
        });
      } catch (drawErr) {
        console.error("❌ 合并资金赔率图绘制失败:", drawErr);
        return res.status(500).json({
          success: false,
          error: "生成合并资金赔率图图片失败",
          detail: drawErr.message,
        });
      }
    }

    res.json({
      success: true,
      data: fundData,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    console.error('❌ 生成多代理合并资金赔率图失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ 新增：根据代理名称生成每日三场账目表（个性化）
app.post("/api/daily-report-by-agent", (req, res) => {
  try {
    const { agent_name, date_str, agent_fee_percent } = req.body;
    
    console.log('📥 收到个人账目表请求:', { agent_name, date_str, agent_fee_percent });
    
    if (!agent_name) {
      return res.status(400).json({
        success: false,
        error: '缺少代理名称参数 agent_name'
      });
    }
    
    const frontendData = getFrontendData();
    if (!frontendData || !frontendData.state) {
      console.log('❌ 无前端数据，无法生成账目表');
      return res.status(404).json({
        success: false,
        error: '前端数据未同步'
      });
    }
    
    const { state } = frontendData;
    
    // 1. 查找该代理
    const agents = state.agents || [];
    const targetAgent = agents.find(a => a.name === agent_name);
    
    if (!targetAgent) {
      console.log('❌ 未找到代理:', agent_name);
      console.log('📋 可用代理:', agents.map(a => a.name));
      return res.status(404).json({
        success: false,
        error: `未找到代理: ${agent_name}`,
        availableAgents: agents.map(a => a.name)
      });
    }
    
    const agentId = targetAgent.id;
    // 优先级：请求参数 > dailyFeeByAgent > targetAgent.feePercent > 默认16
    const feePercent = agent_fee_percent || 
                       state.dailyFeeByAgent?.[agentId] || 
                       targetAgent.feePercent || 
                       16;
    
    console.log('💰 费率计算:', {
      agent_fee_percent: agent_fee_percent,
      dailyFeeByAgent: state.dailyFeeByAgent?.[agentId],
      targetAgentFeePercent: targetAgent.feePercent,
      finalFeePercent: feePercent
    });
    
    // 使用当前日期（如果未提供）
    const today = new Date();
    const dateStr = date_str || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    
    // 2. 计算该代理的三场数据
    const sessions = ['morning_0930', 'noon_1130', 'night_2330'];
    const sessionLabels = {
      'morning_0930': '第一场 09:30',
      'noon_1130': '第二场 11:30',
      'night_2330': '第三场 23:30'
    };
    
    const day = state.bets[dateStr] || {};
    const agentDayData = day[agentId] || {};
    const sessionData = [];
    
    for (const sessionKey of sessions) {
      const sessionPool = agentDayData[sessionKey] || {};
      
      const totalBet = Object.values(sessionPool).reduce((a, b) => a + (b || 0), 0);
      const feeAmt = totalBet * (feePercent / 100);
      const netPool = totalBet - feeAmt;
      
      // 获取该场次的开奖动物
      const winner = state.winners?.[dateStr]?.[agentId]?.[sessionKey] || null;
      
      // 计算最小盈亏（最危险的动物）
      const animalsList = state.animals.length > 0 ? state.animals : Object.keys(sessionPool);
      let minProfit = Infinity;
      let maxProfit = -Infinity;
      
      for (const animal of animalsList) {
        const stake = sessionPool[animal] || 0;
        const payout = stake * 27;
        const profit = netPool - payout;
        if (profit < minProfit) minProfit = profit;
        if (profit > maxProfit) maxProfit = profit;
      }
      
      sessionData.push({
        sessionKey,
        sessionLabel: sessionLabels[sessionKey],
        totalBet,
        feeAmt,
        netPool,
        minProfit: minProfit === Infinity ? 0 : minProfit,
        maxProfit: maxProfit === -Infinity ? 0 : maxProfit,
        winner: winner,  // 新增：开奖动物
        sessionPool: sessionPool  // 新增：投注池数据（用于计算中宝押注和赔付）
      });
    }
    
    // 3. 计算总计
    const totalBetSum = sessionData.reduce((sum, s) => sum + s.totalBet, 0);
    const totalFeeSum = sessionData.reduce((sum, s) => sum + s.feeAmt, 0);
    const totalNetSum = sessionData.reduce((sum, s) => sum + s.netPool, 0);
    const totalMinProfit = sessionData.reduce((sum, s) => sum + s.minProfit, 0);
    const totalMaxProfit = sessionData.reduce((sum, s) => sum + s.maxProfit, 0);
    
    const reportData = {
      agentName: agent_name,
      agentId: agentId,
      dateStr,
      agentFeePercent: feePercent,
      sessions: sessionData,
      totals: {
        totalBet: totalBetSum,
        totalFee: totalFeeSum,
        totalNet: totalNetSum,
        minProfit: totalMinProfit,
        maxProfit: totalMaxProfit
      }
    };
    
    console.log('✅ 个人账目表数据计算完成:', reportData);
    
    const responseFormat = (req.query.format || req.body?.format || "json").toString().toLowerCase();

    if (responseFormat === "image") {
      try {
        const subtitle = `日期：${reportData.dateStr}`;
        const canvas = renderDailyReportImage(reportData, {
          title: `${agent_name} 每日三场账目表`,
          subtitle,
          merged: false,
        });
        const filepath = saveCanvasToFile(canvas, "daily_report", agent_name);
        const imageUrl = `/generated_outputs/${path.basename(filepath)}`;

        return res.json({
          success: true,
          image_path: filepath,
          image_url: imageUrl,
          data: reportData,
          timestamp: new Date().toISOString(),
        });
      } catch (drawErr) {
        console.error("❌ 个人账目表绘制失败:", drawErr);
        return res.status(500).json({
          success: false,
          error: "生成每日账目表图片失败",
          detail: drawErr.message,
        });
      }
    }

    res.json({
      success: true,
      data: reportData,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ 生成个人账目表失败:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ 新增：根据群组名称生成多代理合并的每日三场账目表
app.post("/api/daily-report-by-group-merged", (req, res) => {
  try {
    const { group_name, date_str, agent_fee_percent } = req.body;
    console.log('📥 收到合并账目表请求:', { group_name, date_str, agent_fee_percent });

    if (!group_name) {
      return res.status(400).json({ success: false, error: '缺少群组名称参数 group_name' });
    }

    const frontendData = getFrontendData();
    if (!frontendData || !frontendData.state) {
      console.log('❌ 无前端数据，无法生成账目表');
      return res.status(404).json({ success: false, error: '前端数据未同步' });
    }

    const { state } = frontendData;
    const groups = state.groups || [];
    const targetGroup = groups.find(g => g.name === group_name);
    if (!targetGroup) {
      console.log('❌ 未找到群组:', group_name);
      return res.status(404).json({ success: false, error: `未找到群组: ${group_name}`, availableGroups: groups.map(g => g.name) });
    }

    const agentIds = targetGroup.agentIds || [];
    if (agentIds.length === 0) {
      return res.status(404).json({ success: false, error: `群组"${group_name}"没有关联任何代理` });
    }

    // 使用当前日期（如果未提供）
    const today = new Date();
    const dateStr = date_str || `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    const sessions = ['morning_0930', 'noon_1130', 'night_2330'];
    const sessionLabels = {
      'morning_0930': '第一场 09:30',
      'noon_1130': '第二场 11:30',
      'night_2330': '第三场 23:30'
    };

    const day = state.bets[dateStr] || {};
    const agents = state.agents || [];

    // 费率：优先级 请求参数 > 第一个有效代理 dailyFeeByAgent > 第一个有效代理 feePercent > 16
    const firstValidAgentId = agentIds.find(id => !!agents.find(a => a.id === id)) || agentIds[0];
    const firstAgent = agents.find(a => a.id === firstValidAgentId);
    const feePercent = agent_fee_percent || state.dailyFeeByAgent?.[firstValidAgentId] || firstAgent?.feePercent || 16;

    // 合并三场数据
    const sessionData = [];
    let totalBetSum = 0, totalFeeSum = 0, totalNetSum = 0, totalMinProfit = 0, totalMaxProfit = 0;

    for (const sessionKey of sessions) {
      // 合并该场次的投注池
      const mergedPool = {};
      for (const aid of agentIds) {
        const agentDay = day[aid] || {};
        const pool = agentDay[sessionKey] || {};
        for (const [animal, amt] of Object.entries(pool)) {
          mergedPool[animal] = (mergedPool[animal] || 0) + (amt || 0);
        }
      }

      const totalBet = Object.values(mergedPool).reduce((a, b) => a + (b || 0), 0);
      const feeAmt = totalBet * (feePercent / 100);
      const netPool = totalBet - feeAmt;

      // winner 取当天该场次第一个设置了winner的代理
      let winner = null;
      for (const aid of agentIds) {
        const w = state.winners?.[dateStr]?.[aid]?.[sessionKey];
        if (w) { winner = w; break; }
      }

      // 计算最小/最大盈亏
      const animalsList = state.animals && state.animals.length > 0 ? state.animals : Object.keys(mergedPool);
      let minProfit = Infinity;
      let maxProfit = -Infinity;
      for (const animal of animalsList) {
        const stake = mergedPool[animal] || 0;
        const payout = stake * 27;
        const profit = netPool - payout;
        if (profit < minProfit) minProfit = profit;
        if (profit > maxProfit) maxProfit = profit;
      }

      sessionData.push({
        sessionKey,
        sessionLabel: sessionLabels[sessionKey],
        totalBet,
        feeAmt,
        netPool,
        minProfit: minProfit === Infinity ? 0 : minProfit,
        maxProfit: maxProfit === -Infinity ? 0 : maxProfit,
        winner,
        sessionPool: mergedPool
      });

      totalBetSum += totalBet;
      totalFeeSum += feeAmt;
      totalNetSum += netPool;
      totalMinProfit += (minProfit === Infinity ? 0 : minProfit);
      totalMaxProfit += (maxProfit === -Infinity ? 0 : maxProfit);
    }

    const reportData = {
      groupName: group_name,
      agentIds,
      agentNames,
      dateStr,
      agentFeePercent: feePercent,
      sessions: sessionData,
      totals: {
        totalBet: totalBetSum,
        totalFee: totalFeeSum,
        totalNet: totalNetSum,
        minProfit: totalMinProfit,
        maxProfit: totalMaxProfit
      }
    };

    console.log('✅ 合并账目表数据计算完成');
    const responseFormat = (req.query.format || req.body?.format || "json").toString().toLowerCase();

    if (responseFormat === "image") {
      try {
        const subtitle = `日期：${reportData.dateStr}`;
        const canvas = renderDailyReportImage(reportData, {
          title: `${group_name} 合并每日账目表`,
          subtitle,
          merged: true,
        });
        const filepath = saveCanvasToFile(canvas, "daily_report_merged", group_name);
        const imageUrl = `/generated_outputs/${path.basename(filepath)}`;

        return res.json({
          success: true,
          image_path: filepath,
          image_url: imageUrl,
          data: reportData,
          timestamp: new Date().toISOString(),
        });
      } catch (drawErr) {
        console.error("❌ 合并账目表绘制失败:", drawErr);
        return res.status(500).json({
          success: false,
          error: "生成合并每日账目表图片失败",
          detail: drawErr.message,
        });
      }
    }

    res.json({ success: true, data: reportData, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('❌ 生成合并账目表失败:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ✅ 同步代理到机器人API（代理名=微信群名）
app.post("/api/sync-agents", (req, res) => {
  try {
    const { agent_names, agents } = req.body;
    
    console.log("🤖 收到代理同步请求:", {
      agent_names: agent_names,
      agents_count: agents?.length || 0
    });
    
    const syncData = {
      agent_names: agent_names || [],
      agents: agents || [],
      last_sync: new Date().toISOString()
    };
    
    // 1. 保存同步数据到临时文件
    const fs = require('fs');
    fs.writeFileSync('agent_sync_data.json', JSON.stringify(syncData, null, 2), 'utf8');
    console.log("✅ 代理同步数据已保存到 agent_sync_data.json");
    
    // 2. 更新 config.json 中的监听群组列表（代理名=群名）
    try {
      const configPath = path.join(__dirname, 'config.json');
      let config = {};
      
      // 读取现有配置
      if (fs.existsSync(configPath)) {
        const configContent = fs.readFileSync(configPath, 'utf8');
        config = JSON.parse(configContent);
      }
      
      // 更新监听群组列表（代理名就是群名）
      config['监听群组列表'] = agent_names || [];
      config['群机器人开关'] = agent_names && agent_names.length > 0 ? 'True' : 'False';
      
      // 写回配置文件
      fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8');
      console.log("✅ 已更新 config.json 的监听群组列表（代理名）:", agent_names);
      
      // 3. 立即通知Python机器人重新加载配置
      const http = require('http');
      const postData = JSON.stringify({});
      
      const options = {
        hostname: 'localhost',
        port: 5001,
        path: '/reload-config',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        }
      };
      
      const botRequest = http.request(options, (botRes) => {
        let responseData = '';
        botRes.on('data', (chunk) => {
          responseData += chunk;
        });
        botRes.on('end', () => {
          console.log("✅ 已通知Python机器人重新加载配置:", responseData);
        });
      });
      
      botRequest.on('error', (error) => {
        console.log("⚠️ 通知机器人失败（机器人可能未启动）:", error.message);
      });
      
      botRequest.write(postData);
      botRequest.end();
      
      res.json({
        success: true,
        message: `✅ 已同步 ${agent_names?.length || 0} 个代理到机器人\n\n⚠️ 监听器已重启（可能短暂影响消息接收）\n\n📋 监听群组：${agent_names?.join('、') || '无'}\n\n💡 提示：\n• 仅更新数据时，请使用"同步资金图"按钮\n• 需要更改监听群组时，才使用此按钮`,
        data: syncData,
        config_updated: true,
        listener_restarted: true
      });
    } catch (configError) {
      console.log("❌ 更新 config.json 失败:", configError);
      res.json({
        success: true,
        message: `已同步 ${agent_names?.length || 0} 个代理，但更新配置文件失败: ${configError.message}`,
        data: syncData,
        config_updated: false
      });
    }
  } catch (error) {
    console.log("❌ 同步代理失败:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ 保留旧接口兼容性
app.post("/api/sync-chat-names", (req, res) => {
  console.log("⚠️ 使用了已废弃的 /api/sync-chat-names 接口，请使用 /api/sync-agents");
  // 转发到新接口
  req.body.agent_names = req.body.chat_names;
  req.body.agents = req.body.groups?.map(g => ({ id: g.id, name: g.name })) || [];
  
  const { agent_names, agents } = req.body;
  
  try {
    const fs = require('fs');
    const configPath = path.join(__dirname, 'config.json');
    let config = {};
    
    if (fs.existsSync(configPath)) {
      const configContent = fs.readFileSync(configPath, 'utf8');
      config = JSON.parse(configContent);
    }
    
    config['监听群组列表'] = agent_names || [];
    config['群机器人开关'] = agent_names && agent_names.length > 0 ? 'True' : 'False';
    
    fs.writeFileSync(configPath, JSON.stringify(config, null, 4), 'utf8');
    console.log("✅ 已更新 config.json（通过旧接口）");
    
    res.json({
      success: true,
      message: `已同步 ${agent_names?.length || 0} 个群聊`,
      config_updated: true
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ 触发机器人重新加载配置API
app.post("/api/reload-bot-config", (req, res) => {
  try {
    // 创建一个重载标志文件，Python机器人会定期检查这个文件
    const fs = require('fs');
    const reloadFlag = {
      timestamp: new Date().toISOString(),
      reason: 'config_sync'
    };
    
    fs.writeFileSync('bot_reload_flag.json', JSON.stringify(reloadFlag, null, 2), 'utf8');
    console.log("✅ 已创建机器人重载标志文件");
    
    res.json({
      success: true,
      message: "已通知机器人重新加载配置"
    });
  } catch (error) {
    console.log("❌ 创建重载标志失败:", error);
    res.status(500).json({
      success: false,
      
      error: error.message
    });
  }
});

// 微信消息存储端点（支持按代理名自动分组存储）
app.post("/api/wechat/messages", (req, res) => {
  try {
    const { type, data, timestamp, source } = req.body;
    
    const chatName = data?.chat_name || '';
    const agentName = extractAgentNameFromChat(chatName);
    
    console.log("📱 收到微信消息:", {
      type: type,
      content: data?.content?.substring(0, 50) + "...",
      sender: data?.sender,
      chat_name: chatName,
      agent_name: agentName || '未识别',
      timestamp: timestamp,
      source: source
    });
    
    // 存储到全局内存（兼容旧接口）
    if (!global.wechatMessages) {
      global.wechatMessages = [];
    }
    global.wechatMessages.push({
      type: type,
      data: data,
      timestamp: timestamp,
      source: source,
      received_at: new Date().toISOString()
    });
    
    res.json({
      success: true,
      message: agentName ? `微信消息已存储（代理: ${agentName}）` : "微信消息已存储",
      total_messages: global.wechatMessages.length,
      agent_name: agentName || null
    });
  } catch (error) {
    console.log("❌ 存储微信消息失败:", error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ✅ 获取代理列表API
app.get("/api/agents", (req, res) => {
  try {
    console.log("📋 收到获取代理列表请求");
    
    const frontendData = getFrontendData();
    if (!frontendData || !frontendData.state) {
      console.log('❌ 无前端数据');
      return res.json({
        success: false,
        error: '前端数据未同步',
        agents: []
      });
    }
    
    const { state } = frontendData;
    const agents = state.agents || [];
    
    // 返回代理名称列表
    const agentNames = agents.map(a => a.name);
    
    console.log("✅ 返回代理列表:", agentNames);
    
    res.json({
      success: true,
      agents: agentNames,
      count: agentNames.length
    });
  } catch (error) {
    console.error('❌ 获取代理列表失败:', error);
    res.status(500).json({
      success: false,
      error: error.message,
      agents: []
    });
  }
});

// 获取本机IP地址
const os = require('os');
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (let i = 0; i < iface.length; i++) {
      const alias = iface[i];
      if (alias.family === 'IPv4' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return 'localhost';
}

const localIP = getLocalIP();

app.listen(3000, '0.0.0.0', () => {
  console.log("============================================");
  console.log("✅ Node服务器已启动（支持跨设备访问）");
  console.log("============================================");
  console.log(`📡 本机访问: http://localhost:3000`);
  console.log(`📡 局域网访问: http://${localIP}:3000`);
  console.log(`📡 健康检查: http://${localIP}:3000/health`);
  
  console.log("--------------------------------------------");
  console.log("📊 资金赔率图API:");
  console.log("   - 单代理: /api/fund-chart-by-group");
  console.log("   - 多代理合并: /api/fund-chart-by-group-merged");
  console.log("📈 每日账目表: /api/daily-report-by-agent");
  console.log("📱 微信消息API:");
  console.log("   - 接收消息: POST /api/wechat/messages (自动按代理名分组存储)");
  console.log("📋 数据获取API:");
  console.log("   - 获取所有数据: GET /api/data (兼容旧版本)");
  console.log("   - 按代理名获取: GET /api/data/:agentName (✅ 推荐使用)");
  console.log("   - 清空指定代理: DELETE /api/data/:agentName");
  console.log("📋 代理列表API: /api/agents");
  console.log("🔄 数据同步API:");
  console.log("   - 同步资金图数据: /api/sync-chart-data (推荐日常使用)");
  console.log("   - 同步代理到机器人: /api/sync-agents (更改监听群组时使用)");
  console.log("   - 获取前端状态: /api/frontend-state");
  console.log("============================================");
  console.log(`💡 前端配置: 修改 api-config.json 中的 apiBaseUrl 为: http://${localIP}:3000`);
  console.log("============================================");
});
