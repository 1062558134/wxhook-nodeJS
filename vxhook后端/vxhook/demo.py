# -*- coding: utf8 -*-

import os
import re
import sys
import json
import time
import queue
import base64
import random
import socket
import string
import logging
import traceback
import threading
from typing import Dict, Optional, Tuple, List, Any
from datetime import datetime
from dataclasses import dataclass
from collections import defaultdict
import ctypes
import signal
import inspect
import copy
import requests
from functools import wraps
from ctypes import WinDLL, create_string_buffer, WINFUNCTYPE

import logging
import requests
from typing import Dict, Optional, Tuple, List
from flask import Flask, request

# 获取脚本所在目录
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SCRIPT_DIR)

# 配置日志
log_file = os.path.join(SCRIPT_DIR, 'wechat_service.log')
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(log_file, encoding='utf-8'),
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger('WeChatService')

NODE_SERVER_URL = os.environ.get('NODE_SERVER_URL', 'http://localhost:3000/api/wechat/messages')


def send_message_to_node_server(message_type, data, source="wechat_demo"):
    """将抓取到的消息上报到 Node 服务器"""
    payload = {
        "type": message_type,
        "data": data,
        "timestamp": datetime.now().isoformat(),
        "source": source
    }

    # 确保 payload 可序列化
    try:
        json.dumps(payload, ensure_ascii=False)
    except TypeError:
        payload["data"] = str(data)

    try:
        response = requests.post(NODE_SERVER_URL, json=payload, timeout=3)
        if response.status_code != 200:
            logger.warning(f"Node 服务器响应异常: {response.status_code} - {response.text}")
    except requests.RequestException as exc:
        logger.error(f"发送消息到 Node 服务器失败: {exc}")


def sanitize_value(value):
    """确保所有字段都可 JSON 序列化"""
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    try:
        json.dumps(value, ensure_ascii=False)
        return value
    except (TypeError, ValueError):
        return str(value)


MAPPING_FILE = os.path.join(SCRIPT_DIR, "room_mapping.json")
ROOM_NAME_MAP: Dict[str, str] = {}
ROOM_MEMBER_NAME_MAP: Dict[str, Dict[str, str]] = {}
_MAPPING_MTIME: Optional[float] = None

BOT_AT_KEYWORD = os.environ.get('BOT_AT_KEYWORD')
SELF_WXID: Optional[str] = None
SELF_NICKNAME: Optional[str] = None

OUTPUT_DIR = os.path.join(SCRIPT_DIR, "generated_outputs")
os.makedirs(OUTPUT_DIR, exist_ok=True)


# --- Pillow 基础工具（避免 matplotlib 依赖） ---
try:
    from PIL import Image, ImageDraw, ImageFont  # type: ignore
    PIL_AVAILABLE = True
except ImportError:  # pragma: no cover - 在未安装 Pillow 时走这里
    Image = ImageDraw = ImageFont = None  # type: ignore
    PIL_AVAILABLE = False

_FONT_CACHE: Dict[Tuple[int, bool], "ImageFont.FreeTypeFont"] = {}
_WINDOWS_FONT_DIR = os.path.join(os.environ.get("WINDIR", "C:/Windows"), "Fonts")
_FONT_PATHS_REGULAR: List[str] = [
    os.path.join(_WINDOWS_FONT_DIR, "msyh.ttc"),
    os.path.join(_WINDOWS_FONT_DIR, "msyh.ttf"),
    os.path.join(_WINDOWS_FONT_DIR, "simhei.ttf"),
    os.path.join(_WINDOWS_FONT_DIR, "Deng.ttf"),
]
_FONT_PATHS_BOLD: List[str] = [
    os.path.join(_WINDOWS_FONT_DIR, "msyhbd.ttc"),
    os.path.join(_WINDOWS_FONT_DIR, "simhei.ttf"),
    os.path.join(_WINDOWS_FONT_DIR, "msyh.ttc"),
]


def _ensure_pillow_available() -> bool:
    if PIL_AVAILABLE:
        return True
    logger.error("生成图表需要 Pillow 库，请先执行: pip install pillow")
    return False


def _get_font(size: int, bold: bool = False) -> "ImageFont.FreeTypeFont":
    key = (size, bold)
    cached = _FONT_CACHE.get(key)
    if cached:
        return cached

    search_paths = _FONT_PATHS_BOLD if bold else _FONT_PATHS_REGULAR
    for path in search_paths:
        if path and os.path.exists(path):
            try:
                font = ImageFont.truetype(path, size=size)
                _FONT_CACHE[key] = font
                return font
            except Exception:
                continue

    fallback = ImageFont.load_default()
    _FONT_CACHE[key] = fallback
    return fallback


def _measure_text(text: str, size: int, bold: bool = False) -> Tuple[int, int]:
    font = _get_font(size, bold)
    if hasattr(font, "getbbox"):
        bbox = font.getbbox(text)
        return bbox[2] - bbox[0], bbox[3] - bbox[1]
    return font.getsize(text)


def _draw_text(draw: "ImageDraw.ImageDraw", position: Tuple[float, float], text: str, *, size: int, color: str = "#111827", bold: bool = False) -> None:
    font = _get_font(size, bold)
    draw.text(position, text, fill=color, font=font)


def _draw_right_text(draw: "ImageDraw.ImageDraw", x: float, y: float, text: str, *, size: int, color: str = "#111827", bold: bool = False) -> None:
    width, _ = _measure_text(text, size, bold)
    _draw_text(draw, (x - width, y), text, size=size, color=color, bold=bold)


def _draw_center_text(draw: "ImageDraw.ImageDraw", box: Tuple[float, float, float, float], text: str, *, size: int, color: str = "#111827", bold: bool = False) -> None:
    x0, y0, x1, y1 = box
    width, height = _measure_text(text, size, bold)
    x = x0 + (x1 - x0 - width) / 2
    y = y0 + (y1 - y0 - height) / 2
    _draw_text(draw, (x, y), text, size=size, color=color, bold=bold)


def _draw_left_text(draw: "ImageDraw.ImageDraw", box: Tuple[float, float, float, float], text: str, *, size: int, color: str = "#111827", bold: bool = False, padding: float = 18) -> None:
    x0, y0, x1, y1 = box
    _, height = _measure_text(text, size, bold)
    y = y0 + (y1 - y0 - height) / 2
    _draw_text(draw, (x0 + padding, y), text, size=size, color=color, bold=bold)


def _safe_number(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _format_currency(value) -> str:
    amount = int(round(_safe_number(value)))
    return f"¥{amount:,}"


def _safe_filename_base(name: str) -> str:
    if not name:
        return "unknown"
    cleaned = re.sub(r"[\\/:*?\"<>|]+", "_", str(name))
    cleaned = cleaned.strip(" _")
    return cleaned or "chart"


def _save_image(image: "Image.Image", prefix: str, name_hint: str) -> str:
    safe_name = _safe_filename_base(name_hint)
    filename = f"{prefix}_{safe_name}_{datetime.now().strftime('%Y%m%d_%H%M%S')}.png"
    filepath = os.path.join(OUTPUT_DIR, filename)
    image.save(filepath, format="PNG")
    logger.info("图像已生成: %s", filepath)
    return filepath


_SESSION_LABELS = {
    "morning_0930": "第一场 09:30",
    "noon_1130": "第二场 11:30",
    "night_2330": "第三场 23:30",
}


def _session_label(session_key: Optional[str]) -> str:
    if not session_key:
        return "未知场次"
    return _SESSION_LABELS.get(session_key, session_key)


def _render_fund_chart_image(data: Dict, *, title: str, subtitle: str, name_hint: str, merged: bool = False) -> Optional[str]:
    if not _ensure_pillow_available():
        return None

    items = data.get("items") or []
    if not items:
        logger.warning("资金赔率图数据为空")
        return None

    items_sorted = sorted(items, key=lambda x: x.get("profit", 0))
    width = 960
    margin_left = 200
    margin_right = 120
    margin_top = 190
    margin_bottom = 140
    row_height = 64
    row_gap = 8
    total_rows = len(items_sorted)
    table_height = total_rows * row_height + max(0, (total_rows - 1) * row_gap)
    height = margin_top + margin_bottom + table_height

    image = Image.new("RGB", (width, height), "#FFBC8C")
    draw = ImageDraw.Draw(image)

    chart_title = title
    _draw_text(draw, (40, 40), chart_title, size=32, color="#1F2937", bold=True)
    _draw_text(draw, (40, 86), subtitle, size=22, color="#374151")

    total_bet = data.get("totalBet", 0)
    fee_amt = data.get("feeAmt", 0)
    net_pool = data.get("netPool", 0)
    summary_line = f"总押注：{_format_currency(total_bet)}   代理费：{_format_currency(fee_amt)}   净资金池：{_format_currency(net_pool)}"
    _draw_text(draw, (40, 130), summary_line, size=20, color="#4B5563")

    if merged:
        agent_names = data.get("agentNames") or []
        if agent_names:
            agent_text = "、".join(agent_names[:5])
            if len(agent_names) > 5:
                agent_text += f" 等{len(agent_names)}个代理"
            _draw_text(draw, (40, 162), f"包含代理：{agent_text}", size=18, color="#4B5563")
    elif data.get("agentName"):
        _draw_text(draw, (40, 162), f"代理：{data.get('agentName')}", size=18, color="#4B5563")

    bar_area_width = width - margin_left - margin_right
    max_stake = max((item.get("stake", 0) or 0) for item in items_sorted) or 1
    worst_profit = min((item.get("profit", 0) for item in items_sorted), default=0)

    header_y = margin_top - 46
    _draw_left_text(draw, (40, header_y, margin_left - 24, header_y + 36), "动物", size=20, bold=True)
    _draw_left_text(draw, (margin_left, header_y, width - margin_right, header_y + 36), "押注分布", size=20, bold=True)
    _draw_right_text(draw, width - margin_right, header_y, "输赢 (¥)", size=20, bold=True)

    for idx, item in enumerate(items_sorted):
        top_y = margin_top + idx * (row_height + row_gap)
        bottom_y = top_y + row_height
        bg_color = "#FECBAA" if idx % 2 == 0 else "#FDBA8C"
        draw.rounded_rectangle((30, top_y, width - 30, bottom_y), radius=18, fill=bg_color)

        animal = str(item.get("animal", "-"))
        stake = max(item.get("stake", 0) or 0, 0)
        payout = item.get("payout", stake * 27)
        profit = item.get("profit", 0)

        _draw_text(draw, (48, top_y + 18), animal, size=22, color="#1F2937", bold=True)
        _draw_text(draw, (48, top_y + 42), f"押注：{_format_currency(stake)}  赔付：{_format_currency(payout)}", size=16, color="#4B5563")

        if max_stake > 0:
            bar_length = int((stake / max_stake) * (bar_area_width - 20))
        else:
            bar_length = 0
        bar_top = top_y + 18
        bar_bottom = bottom_y - 18
        bar_left = margin_left
        bar_right = margin_left + max(bar_length, 6)
        draw.rounded_rectangle((bar_left, bar_top, bar_right, bar_bottom), radius=12, fill="#10B981")

        profit_color = "#DC2626" if profit < 0 else ("#047857" if profit > 0 else "#1F2937")
        profit_text = _format_currency(profit)
        if profit > 0:
            profit_text = "+" + profit_text
        _draw_right_text(draw, width - margin_right, top_y + 26, profit_text, size=22, color=profit_color, bold=True)

    if worst_profit < 0:
        warning_text = "⚠️ 红色表示可能亏损的动物，请及时调整赔率。"
        _draw_text(draw, (40, height - margin_bottom + 40), warning_text, size=18, color="#B91C1C")

    return _save_image(image, "fund_chart", name_hint)


def _render_daily_report_image(data: Dict, *, title: str, subtitle: str, name_hint: str, merged: bool = False) -> Optional[str]:
    if not _ensure_pillow_available():
        return None

    sessions = data.get("sessions") or []
    if not sessions:
        logger.warning("账目表数据为空")
        return None

    totals = data.get("totals") or {}
    width = 1120
    margin = 48
    header_height = 170
    footer_height = 110
    row_height = 72
    total_rows = len(sessions) + 1  # 包含合计
    height = header_height + footer_height + total_rows * row_height

    image = Image.new("RGB", (width, height), "#FFFFFF")
    draw = ImageDraw.Draw(image)

    _draw_text(draw, (margin, 38), title, size=32, color="#111827", bold=True)
    _draw_text(draw, (margin, 86), subtitle, size=22, color="#374151")

    fee_percent = data.get("agentFeePercent")
    if fee_percent is not None:
        _draw_text(draw, (margin, 120), f"代理费率：{fee_percent}%", size=20, color="#4B5563")

    if merged:
        agent_names = data.get("agentIds") or []
        if agent_names:
            _draw_text(draw, (margin, 150), f"合并代理数：{len(agent_names)}", size=18, color="#4B5563")
    elif data.get("agentName"):
        _draw_text(draw, (margin, 150), f"代理：{data.get('agentName')}", size=18, color="#4B5563")

    columns = [
        ("场次", 120),
        ("开宝", 130),
        ("总押注", 170),
        ("中宝押注", 170),
        ("代理费", 170),
        ("中宝赔付", 170),
        ("输赢", 170),
    ]

    x_positions: List[int] = []
    current_x = margin
    for _, width_px in columns:
        x_positions.append(current_x)
        current_x += width_px

    table_top = header_height
    header_bottom = table_top + row_height
    draw.rounded_rectangle((margin, table_top, current_x, header_bottom), radius=12, fill="#E5F4FF")
    for (col_name, width_px), x in zip(columns, x_positions):
        _draw_center_text(draw, (x, table_top, x + width_px, header_bottom), col_name, size=20, color="#1F2937", bold=True)

    def _draw_row(y: int, row_values: List[str], *, highlight: bool = False) -> None:
        row_bottom = y + row_height
        bg_color = "#F3F4F6" if highlight else "#FFFFFF"
        draw.rounded_rectangle((margin, y, current_x, row_bottom), radius=12, fill=bg_color)
        for (col_name, width_px), x, text in zip(columns, x_positions, row_values):
            anchor_box = (x, y, x + width_px, row_bottom)
            _draw_center_text(draw, anchor_box, text, size=18, color="#1F2937")

    for idx, session in enumerate(sessions):
        y = header_bottom + idx * row_height
        total_bet = session.get("totalBet", 0)
        fee_amt = session.get("feeAmt", 0)
        winner = session.get("winner")
        session_pool = session.get("sessionPool", {}) or {}
        winner_stake = session_pool.get(winner, 0) if winner else 0
        winner_payout = winner_stake * 27 if winner else 0
        min_profit = session.get("minProfit", total_bet - fee_amt - winner_payout)
        profit_value = min_profit if winner is None else total_bet - fee_amt - winner_payout

        row_values = [
            _session_label(session.get("sessionKey")),
            winner or "未设置",
            _format_currency(total_bet),
            _format_currency(winner_stake),
            _format_currency(fee_amt),
            _format_currency(winner_payout),
            _format_currency(profit_value),
        ]

        highlight = profit_value < 0
        _draw_row(y, row_values, highlight=highlight)
        profit_color = "#DC2626" if profit_value < 0 else "#047857" if profit_value > 0 else "#1F2937"
        profit_box = (x_positions[-1], y, x_positions[-1] + columns[-1][1], y + row_height)
        _draw_center_text(draw, profit_box, row_values[-1], size=18, color=profit_color, bold=True)

    totals_row_y = header_bottom + len(sessions) * row_height
    totals_values = [
        "合计",
        "/",
        _format_currency(totals.get("totalBet", 0)),
        _format_currency(0),
        _format_currency(totals.get("totalFee", 0)),
        _format_currency(0),
        _format_currency(totals.get("minProfit", 0)),
    ]
    _draw_row(totals_row_y, totals_values, highlight=totals.get("minProfit", 0) < 0)

    final_profit = totals.get("minProfit", 0)
    footer_y = header_height + total_rows * row_height + 24
    footer_text = f"实际盈亏：{_format_currency(final_profit)}"
    footer_color = "#DC2626" if final_profit < 0 else "#047857" if final_profit > 0 else "#1F2937"
    _draw_text(draw, (margin, footer_y), footer_text, size=22, color=footer_color, bold=True)

    if final_profit < 0:
        _draw_text(draw, (margin, footer_y + 38), "⚠️ 当前存在亏损，请关注中宝赔付与代理费率设置。", size=18, color="#B91C1C")

    return _save_image(image, "daily_report", name_hint)


def load_mappings(force: bool = False):
    """从外部 JSON 文件加载群聊 / 成员映射"""
    global ROOM_NAME_MAP, ROOM_MEMBER_NAME_MAP, _MAPPING_MTIME

    try:
        mtime = os.path.getmtime(MAPPING_FILE)
        if not force and _MAPPING_MTIME == mtime:
            return

        with open(MAPPING_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)

        room_names = data.get("room_names", {})
        room_members = data.get("room_members", {})

        if not isinstance(room_names, dict) or not isinstance(room_members, dict):
            raise ValueError("room_mapping.json 格式不正确，应包含 room_names / room_members 字典")

        ROOM_NAME_MAP = {str(k): str(v) for k, v in room_names.items()}
        ROOM_MEMBER_NAME_MAP = {
            str(room): {str(member): str(name) for member, name in members.items()}
            for room, members in room_members.items()
            if isinstance(members, dict)
        }
        _MAPPING_MTIME = mtime
        logger.info("映射表已加载：群聊 %d 个，成员映射 %d 个", len(ROOM_NAME_MAP), len(ROOM_MEMBER_NAME_MAP))
    except FileNotFoundError:
        if _MAPPING_MTIME is None:
            logger.warning("未找到映射文件 %s，使用空映射", MAPPING_FILE)
        ROOM_NAME_MAP = {}
        ROOM_MEMBER_NAME_MAP = {}
        _MAPPING_MTIME = None
    except Exception as exc:
        logger.error("加载映射表失败: %s", exc)


# 启动时先尝试加载一次映射
load_mappings(force=True)


def normalize_wechat_data(message_type, data):
    """解析并补充消息字段，填入 chat_name / sender 等"""
    normalized = {}
    raw_dict = None

    if isinstance(data, str):
        try:
            raw_dict = json.loads(data)
        except (TypeError, ValueError):
            raw_dict = None
        normalized["raw"] = data
    elif isinstance(data, dict):
        raw_dict = copy.deepcopy(data)
    else:
        normalized["raw"] = sanitize_value(data)

    if isinstance(raw_dict, dict):
        # 复制原始字段
        for key, value in raw_dict.items():
            normalized[key] = sanitize_value(value)

        def pick(*keys):
            for key in keys:
                value = raw_dict.get(key)
                if value:
                    return value
            return None

        chat_name = pick("room_nickname", "chatroom_nickname", "group_nickname", "chat_name", "room_name", "group_name")
        if not chat_name:
            chat_name = pick("room_wxid", "chatroom_id", "room_id")
        if chat_name:
            normalized["chat_name"] = chat_name

        chat_wxid = pick("room_wxid", "chatroom_id", "room_id", "target_id")
        if chat_wxid:
            normalized["chat_wxid"] = chat_wxid

        sender_name = pick("sender_nickname", "sender_name", "user_nickname", "nick_name", "member_nickname", "displayname")
        if not sender_name:
            sender_name = pick("sender", "from_nick")
        if sender_name:
            normalized["sender"] = sender_name

        sender_wxid = pick("sender_wxid", "sender_id", "user_wxid", "from_wxid", "wxid")
        if sender_wxid:
            normalized["sender_wxid"] = sender_wxid

        content = pick("content", "msg_content", "message", "text", "msg")
        if content:
            normalized["content"] = content

    chat_wxid = normalized.get("chat_wxid")
    sender_wxid = normalized.get("sender_wxid")

    # 实时检测映射文件是否有更新
    load_mappings(force=False)

    if chat_wxid:
        mapped_room_name = ROOM_NAME_MAP.get(chat_wxid)
        if mapped_room_name:
            if normalized.get("chat_name") in (None, "", chat_wxid):
                normalized["chat_name"] = mapped_room_name

    if chat_wxid and sender_wxid:
        member_map = ROOM_MEMBER_NAME_MAP.get(chat_wxid, {})
        mapped_sender_name = member_map.get(sender_wxid)
        if mapped_sender_name:
            if normalized.get("sender") in (None, "", sender_wxid):
                normalized["sender"] = mapped_sender_name

    normalized["message_type"] = message_type
    return normalized


def _request_generated_image(endpoint: str, payload: Dict[str, Any]) -> Optional[str]:
    """调用 Node 后端图片生成接口并返回图片路径"""
    url = f"http://localhost:3000{endpoint}"
    request_body = dict(payload)
    request_body["format"] = "image"

    try:
        response = requests.post(url, json=request_body, timeout=15)
    except Exception as exc:
        logger.error("请求 %s 失败: %s", endpoint, exc)
        logger.debug(traceback.format_exc())
        return None

    if response.status_code != 200:
        logger.error("接口 %s 返回错误: %s - %s", endpoint, response.status_code, response.text)
        return None

    try:
        result = response.json()
    except ValueError:
        logger.error("接口 %s 返回的不是 JSON: %s", endpoint, response.text[:200])
        return None

    if not result.get("success"):
        logger.error("接口 %s 返回失败: %s", endpoint, result.get("error"))
        return None

    image_path = result.get("image_path")
    if image_path:
        logger.info("图片已生成: %s", image_path)
        return image_path

    logger.warning("接口 %s 未提供 image_path，返回数据: %s", endpoint, result)
    return None


def generate_fund_chart_image(group_name: str) -> Optional[str]:
    """调用 Node 后端生成资金赔率图并返回图片路径"""
    logger.info("开始生成群 %s 的资金赔率图", group_name)
    return _request_generated_image(
        endpoint="/api/fund-chart-by-group",
        payload={"group_name": group_name},
    )


def update_self_identity_from_login(data):
    """从登录事件中提取自身 wxid 和昵称"""
    global SELF_WXID, SELF_NICKNAME
    if not isinstance(data, dict):
        return

    wxid = data.get("wxid") or data.get("self_wxid")
    nickname = data.get("nickname") or data.get("self_nickname")

    if wxid and wxid != SELF_WXID:
        SELF_WXID = wxid
        logger.info("已记录机器人 wxid: %s", SELF_WXID)
    if nickname and nickname != SELF_NICKNAME:
        SELF_NICKNAME = nickname
        logger.info("已记录机器人昵称: %s", SELF_NICKNAME)


def send_group_text_message(room_wxid: str, content: str) -> bool:
    """通过底层接口向群聊发送文本消息"""
    global _service_instance
    if not room_wxid:
        logger.warning("缺少 room_wxid，无法发送消息")
        return False
    if not content:
        logger.warning("消息内容为空，跳过发送")
        return False
    if not _service_instance:
        logger.error("服务实例未初始化，无法发送群消息")
        return False

    payload = {
        "type": MessageType.MT_SEND_TEXTMSG,
        "data": {
            "room_wxid": room_wxid,
            "content": content,
        },
    }
    message = json.dumps(payload, ensure_ascii=False)
    return bool(_service_instance.send_message(message))


def _is_group_chat(chat_wxid: Optional[str]) -> bool:
    return bool(chat_wxid and chat_wxid.endswith("@chatroom"))


def _extract_message_content(normalized: Dict) -> str:
    content = normalized.get("content")
    if not content:
        content = normalized.get("msg")
    return content or ""


def _is_bot_mentioned(normalized: Dict) -> bool:
    content = _extract_message_content(normalized)
    at_user_list = normalized.get("at_user_list") or normalized.get("at_list")

    if isinstance(at_user_list, list) and SELF_WXID and SELF_WXID in at_user_list:
        return True
    if BOT_AT_KEYWORD and BOT_AT_KEYWORD in content:
        return True
    if SELF_NICKNAME and f"@{SELF_NICKNAME}" in content:
        return True
    return False


def _fetch_available_agents() -> Optional[list]:
    try:
        response = requests.get("http://localhost:3000/api/agents", timeout=5)
        if response.status_code != 200:
            return None
        data = response.json()
        if not data.get("success"):
            return None
        return data.get("agents", [])
    except Exception as exc:
        logger.warning("获取代理列表失败: %s", exc)
        return None


def process_group_command(normalized: Dict) -> bool:
    """处理群聊指令，返回是否已处理"""
    chat_wxid = normalized.get("chat_wxid") or normalized.get("room_wxid")
    if not _is_group_chat(chat_wxid):
        return False

    if not _is_bot_mentioned(normalized):
        return False

    content = _extract_message_content(normalized)
    if not content:
        return False

    group_name = normalized.get("chat_name") or ROOM_NAME_MAP.get(chat_wxid) or chat_wxid
    sender_name = normalized.get("sender") or normalized.get("sender_name") or normalized.get("from_nick") or ""

    # 资金赔率图
    if "666" not in content and "777" not in content and "2" not in content and "1" not in content:
        logger.debug("提及了机器人但未匹配到指令: %s", content)
        return False

    if "1" in content:
        image_path = generate_fund_chart_image(group_name)
        if image_path:
            send_group_text_message(
                chat_wxid,
                f"✅ 资金赔率图已生成，保存在：{image_path}",
            )
        else:
            error_msg = (
                "❌ 无法生成资金赔率图\n可能原因：\n"
                "1. 该群未配置代理\n2. 当前场次无投注数据\n3. 后端服务未启动"
            )
            send_group_text_message(chat_wxid, error_msg)
        return True

    if "666" in content:
        image_path = generate_merged_fund_chart_image(group_name)
        if image_path:
            send_group_text_message(
                chat_wxid,
                f"✅ 多代理合并资金赔率图已生成，保存在：{image_path}",
            )
        else:
            error_msg = (
                "❌ 无法生成多代理合并资金图\n\n可能原因：\n"
                "1. 前端未配置该群组\n2. 该群组没有关联代理\n3. 关联代理没有投注数据\n4. 后端服务未启动"
            )
            send_group_text_message(chat_wxid, error_msg)
        return True

    if "2" in content:
        image_path = generate_daily_report_image(group_name)
        if image_path:
            send_group_text_message(
                chat_wxid,
                f"✅ {group_name} 的每日三场账目表已生成，保存在：{image_path}",
            )
        else:
            available_agents = _fetch_available_agents() or []
            if available_agents and group_name not in available_agents:
                error_msg = (
                    f"❌ 无法生成账目表\n\n群聊名称：{group_name}\n\n可能原因：\n"
                    f"1. 前端未找到代理「{group_name}」\n2. 请确认群聊名称与前端代理名称一致\n\n"
                    "📋 当前系统中的代理列表：\n"
                    + "\n".join([f"  {idx + 1}. {agent}" for idx, agent in enumerate(available_agents)])
                    + "\n\n💡 提示：请在前端添加对应代理，并同步到机器人"
                )
            else:
                error_msg = (
                    "❌ 无法生成账目表\n可能原因：\n"
                    "1. 今日无投注数据\n2. 后端服务异常\n3. 数据未同步到后端"
                )
            send_group_text_message(chat_wxid, error_msg)
        return True

    if "777" in content:
        image_path = generate_merged_daily_report_image(group_name)
        if image_path:
            send_group_text_message(
                chat_wxid,
                f"✅ 合并账目表已生成，保存在：{image_path}",
            )
        else:
            error_msg = (
                "❌ 无法生成合并账目表\n可能原因：\n"
                "1. 群组未关联代理\n2. 关联代理没有投注数据\n3. 后端服务未启动"
            )
            send_group_text_message(chat_wxid, error_msg)
        return True

    return False


def generate_merged_fund_chart_image(group_name: str) -> Optional[str]:
    """调用 Node 后端生成多代理合并资金赔率图并返回图片路径"""
    logger.info("开始生成群组 %s 的多代理合并资金赔率图", group_name)
    return _request_generated_image(
        endpoint="/api/fund-chart-by-group-merged",
        payload={"group_name": group_name},
    )

def generate_daily_report_image(agent_name: str) -> Optional[str]:
    """调用 Node 后端生成人工每日账目表并返回图片路径"""
    logger.info("开始生成代理 %s 的每日账目表", agent_name)
    return _request_generated_image(
        endpoint="/api/daily-report-by-agent",
        payload={"agent_name": agent_name},
    )


def generate_merged_daily_report_image(group_name: str) -> Optional[str]:
    """调用 Node 后端生成合并每日账目表并返回图片路径"""
    logger.info("开始生成群 %s 的合并每日账目表", group_name)
    return _request_generated_image(
        endpoint="/api/daily-report-by-group-merged",
        payload={"group_name": group_name},
    )

def is_64bit():
    return sys.maxsize > 2 ** 32


def c_string(data):
    return ctypes.c_char_p(data.encode('utf-8'))


class MessageType:
    MT_DEBUG_LOG = 11024
    MT_USER_LOGIN = 11025
    MT_USER_LOGOUT = 11026
    MT_USER_LOGOUT2 = 11027
    MT_SEND_TEXTMSG = 11036


class IncomingMessageType:
    TEXT_MESSAGE = 11046


class CallbackHandler:
    pass


class WeChatServiceHandler(CallbackHandler):
    """微信服务回调处理器占位，稍后重新定义在装饰器之后"""
    pass


_GLOBAL_CONNECT_CALLBACK_LIST = []
_GLOBAL_RECV_CALLBACK_LIST = []
_GLOBAL_CLOSE_CALLBACK_LIST = []


def CONNECT_CALLBACK(in_class=False):
    def decorator(f):
        wraps(f)
        if in_class:
            f._wx_connect_handled = True
        else:
            _GLOBAL_CONNECT_CALLBACK_LIST.append(f)
        return f

    return decorator


def RECV_CALLBACK(in_class=False):
    def decorator(f):
        wraps(f)
        if in_class:
            f._wx_recv_handled = True
        else:
            _GLOBAL_RECV_CALLBACK_LIST.append(f)
        return f

    return decorator


def CLOSE_CALLBACK(in_class=False):
    def decorator(f):
        wraps(f)
        if in_class:
            f._wx_close_handled = True
        else:
            _GLOBAL_CLOSE_CALLBACK_LIST.append(f)
        return f

    return decorator


def add_callback_handler(callbackHandler):
    for dummy, handler in inspect.getmembers(callbackHandler, callable):
        if hasattr(handler, '_wx_connect_handled'):
            _GLOBAL_CONNECT_CALLBACK_LIST.append(handler)
        elif hasattr(handler, '_wx_recv_handled'):
            _GLOBAL_RECV_CALLBACK_LIST.append(handler)
        elif hasattr(handler, '_wx_close_handled'):
            _GLOBAL_CLOSE_CALLBACK_LIST.append(handler)


@WINFUNCTYPE(None, ctypes.c_void_p)
def wechat_connect_callback(client_id):
    for func in _GLOBAL_CONNECT_CALLBACK_LIST:
        func(client_id)


@WINFUNCTYPE(None, ctypes.c_long, ctypes.c_char_p, ctypes.c_ulong)
def wechat_recv_callback(client_id, data, length):
    try:
        # 按 length 从指针读取原始字节，避免因嵌入 \x00 导致截断
        raw_bytes = ctypes.string_at(data, length) if data and length else b""
        # 去掉尾部填充的空字节与空白
        raw_bytes = raw_bytes.rstrip(b"\x00 \t\r\n")
        # 记录原始长度和前后各一段，便于排查乱码/多包问题
        logger.debug(f"接收原始数据长度: {len(raw_bytes)}, 预览前256: {raw_bytes[:256]!r}")
        if not raw_bytes:
            logger.warning("收到空数据帧")
            return
        # 尝试 UTF-8 解码（忽略非法字节，避免抛异常）
        json_text = raw_bytes.decode('utf-8', errors='ignore').strip()
        if not json_text:
            logger.warning("解码后为空文本")
            return

        # 有些实现可能一次返回多个 JSON 对象（无分隔或以换行分隔）
        # 优先尝试整体解析；若为数组则逐个分发；若失败则使用增量解析
        dispatched = False
        try:
            parsed = json.loads(json_text)
            if isinstance(parsed, list):
                for item in parsed:
                    if not isinstance(item, dict):
                        continue
                    msg_type = item.get('type')
                    msg_data = item.get('data')
                    if msg_type is None:
                        logger.error(f"数组元素缺少 type 字段: {item}")
                        continue
                    for func in _GLOBAL_RECV_CALLBACK_LIST:
                        func(client_id, msg_type, msg_data)
                dispatched = True
            elif isinstance(parsed, dict):
                msg_type = parsed.get('type')
                msg_data = parsed.get('data')
                if msg_type is None:
                    logger.error(f"收到数据缺少 type 字段: {parsed}")
                    return
                for func in _GLOBAL_RECV_CALLBACK_LIST:
                    func(client_id, msg_type, msg_data)
                dispatched = True
        except Exception:
            # 故意吞掉，转入增量解析
            dispatched = False

        if not dispatched:
            # 使用 JSONDecoder 原地逐段解析，处理多 JSON 串联的情况
            decoder = json.JSONDecoder()
            idx = 0
            text_len = len(json_text)
            any_chunk = False
            while idx < text_len:
                # 跳过空白与换行
                while idx < text_len and json_text[idx].isspace():
                    idx += 1
                if idx >= text_len:
                    break
                try:
                    obj, end = decoder.raw_decode(json_text, idx)
                    any_chunk = True
                    idx = end
                    if isinstance(obj, dict):
                        msg_type = obj.get('type')
                        msg_data = obj.get('data')
                        if msg_type is None:
                            logger.error(f"片段缺少 type 字段: {obj}")
                            continue
                        for func in _GLOBAL_RECV_CALLBACK_LIST:
                            func(client_id, msg_type, msg_data)
                    elif isinstance(obj, list):
                        for item in obj:
                            if not isinstance(item, dict):
                                continue
                            msg_type = item.get('type')
                            msg_data = item.get('data')
                            if msg_type is None:
                                logger.error(f"数组片段元素缺少 type 字段: {item}")
                                continue
                            for func in _GLOBAL_RECV_CALLBACK_LIST:
                                func(client_id, msg_type, msg_data)
                    else:
                        logger.debug(f"忽略非对象/数组的 JSON 片段: {type(obj)}")
                except Exception as ie:
                    # 无法解析当前位置，尝试找到下一个 '{' 或 '[' 再继续
                    # 若剩余只包含空白或空字符，则视为正常结束
                    tail = json_text[idx:]
                    if tail.strip().strip("\x00") == "":
                        break
                    next_obj_pos = -1
                    brace_pos = json_text.find('{', idx + 1)
                    bracket_pos = json_text.find('[', idx + 1)
                    candidates = [p for p in [brace_pos, bracket_pos] if p != -1]
                    if candidates:
                        next_obj_pos = min(candidates)
                    if next_obj_pos == -1:
                        logger.error(f"增量解析失败，剩余内容: {json_text[idx:idx+200]!r}... 错误: {ie}")
                        break
                    else:
                        logger.debug(f"跳至下一个可能 JSON 起点: {next_obj_pos}（原因: {ie}）")
                        idx = next_obj_pos
            if not any_chunk:
                # 既不是整体，也不是增量，输出精简预览
                if json_text.strip().strip("\x00") != "":
                    logger.error(f"解析接收数据失败（未识别到任何 JSON 对象）。预览: {json_text[:300]!r}")
    except Exception as e:
        # 打印尽可能多的上下文以定位问题
        try:
            logger.error(f"解析接收数据失败: {e}")
        except Exception:
            pass


@WINFUNCTYPE(None, ctypes.c_ulong)
def wechat_close_callback(client_id):
    for func in _GLOBAL_CLOSE_CALLBACK_LIST:
        func(client_id)


class WeChatServiceHandler(CallbackHandler):
    """微信服务回调处理器"""
    
    def __init__(self, service):
        self.service = service
        self.connected_clients = set()
    
    @CONNECT_CALLBACK(in_class=True)
    def on_connect(self, client_id):
        """客户端连接回调"""
        self.connected_clients.add(client_id)
        # 更新心跳时间
        self.service.last_heartbeat = time.time()
        # 记录当前活跃的 socket client_id，供发送使用
        self.service.current_client_id = client_id
        logger.info(f"客户端 {client_id} 已连接，当前连接数: {len(self.connected_clients)}")
        
    @RECV_CALLBACK(in_class=True)
    def on_receive(self, client_id, message_type, data):
        """接收消息回调"""
        # 更新心跳时间
        self.service.last_heartbeat = time.time()
        logger.info(f"收到来自客户端 {client_id} 的消息 - 类型: {message_type}, 数据: {data}")

        # 将抓取到的数据同步到 Node 服务器
        normalized_data = normalize_wechat_data(message_type, data)
        send_message_to_node_server(message_type, normalized_data)
        
        # 处理不同类型的消息
        if message_type == MessageType.MT_USER_LOGIN:
            logger.info(f"用户登录: {data}")
            update_self_identity_from_login(data if isinstance(data, dict) else normalized_data)
            # 登录成功后发送一次业务消息（固定 ROOM_WXID）
            try:
                self.service.send_startup_payload(room_wxid="47945916190@chatroom", status=0)
            except Exception as e:
                logger.error(f"登录回调发送启动消息失败: {e}")

        elif message_type == MessageType.MT_USER_LOGOUT:
            logger.info(f"用户登出: {data}")
        elif message_type == MessageType.MT_DEBUG_LOG:
            logger.debug(f"调试日志: {data}")
        elif message_type == IncomingMessageType.TEXT_MESSAGE:
            try:
                handled = process_group_command(normalized_data)
                if handled:
                    logger.info("已处理群聊指令: %s", normalized_data.get("content") or normalized_data.get("msg"))
            except Exception as exc:
                logger.error("处理群聊指令失败: %s", exc)
                logger.debug(traceback.format_exc())
            
    @CLOSE_CALLBACK(in_class=True)
    def on_close(self, client_id):
        """客户端断开回调"""
        self.connected_clients.discard(client_id)
        logger.info(f"客户端 {client_id} 已断开，当前连接数: {len(self.connected_clients)}")


class NoveLoader:
    # 加载器
    loader_module_base: int = 0

    # 偏移
    _InitWeChatSocket: int = 0xB080
    _GetUserWeChatVersion: int = 0xCB80
    _InjectWeChat: int = 0xCC10
    _SendWeChatData: int = 0xAF90
    _DestroyWeChat: int = 0xC540
    _UseUtf8: int = 0xC680
    _InjectWeChat2: int = 0xCC30
    _InjectWeChatPid: int = 0xB750
    _InjectWeChatMultiOpen: int = 0xC780

    # _GetInstallWeixinVersion: int = 0x0
    # _InjectWeixin: int = 0x0
    # _InjectWeixin2: int = 0x0
    # _SetWeixinDataLocationPath: int = 0x0
    # _GetWeixinDataLocationPath: int = 0x0

    def __init__(self, loader_path: str):
        loader_path = os.path.realpath(loader_path)
        if not os.path.exists(loader_path):
            error_msg = f'Loader DLL 文件不存在: {loader_path}'
            logger.error(error_msg)
            raise FileNotFoundError(error_msg)

        try:
            loader_module = WinDLL(loader_path)
            self.loader_module_base = loader_module._handle

            # 使用utf8编码
            self.UseUtf8()

            # 初始化接口回调
            self.InitWeChatSocket(wechat_connect_callback, wechat_recv_callback, wechat_close_callback)
        except Exception as e:
            logger.error(f"加载 Loader DLL 失败: {e}")
            raise

    def __get_non_exported_func(self, offset: int, arg_types, return_type):
        func_addr = self.loader_module_base + offset
        if arg_types:
            func_type = ctypes.WINFUNCTYPE(return_type, *arg_types)
        else:
            func_type = ctypes.WINFUNCTYPE(return_type)
        return func_type(func_addr)

    def add_callback_handler(self, callback_handler):
        add_callback_handler(callback_handler)

    def InitWeChatSocket(self, connect_callback, recv_callback, close_callback):
        func = self.__get_non_exported_func(self._InitWeChatSocket, [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p], ctypes.c_bool)
        return func(connect_callback, recv_callback, close_callback)

    def GetUserWeChatVersion(self) -> str:
        func = self.__get_non_exported_func(self._GetUserWeChatVersion, None, ctypes.c_bool)
        out = create_string_buffer(20)
        if func(out):
            return out.value.decode('utf-8')
        else:
            return ''

    def InjectWeChat(self, dll_path: str) -> ctypes.c_uint32:
        func = self.__get_non_exported_func(self._InjectWeChat, [ctypes.c_char_p], ctypes.c_uint32)
        return func(c_string(dll_path))

    def SendWeChatData(self, client_id: int, message: str) -> ctypes.c_bool:
        func = self.__get_non_exported_func(self._SendWeChatData, [ctypes.c_uint32, ctypes.c_char_p], ctypes.c_bool)
        return func(client_id, c_string(message))

    def DestroyWeChat(self) -> ctypes.c_bool:
        func = self.__get_non_exported_func(self._DestroyWeChat, None, ctypes.c_bool)
        return func()

    def UseUtf8(self):
        func = self.__get_non_exported_func(self._UseUtf8, None, ctypes.c_bool)
        return func()

    def InjectWeChat2(self, dll_path: str, exe_path: str) -> ctypes.c_uint32:
        func = self.__get_non_exported_func(self._InjectWeChat2, [ctypes.c_char_p, ctypes.c_char_p], ctypes.c_uint32)
        return func(c_string(dll_path), c_string(exe_path))

    def InjectWeChatPid(self, pid: int, dll_path: str) -> ctypes.c_uint32:
        func = self.__get_non_exported_func(self._InjectWeChatPid, [ctypes.c_uint32, ctypes.c_char_p], ctypes.c_uint32)
        return func(pid, c_string(dll_path))

    def InjectWeChatMultiOpen(self, dll_path: str, exe_path: str) -> ctypes.c_uint32:
        func = self.__get_non_exported_func(self._InjectWeChatMultiOpen, [ctypes.c_char_p, ctypes.c_char_p], ctypes.c_uint32)
        return func(c_string(dll_path), c_string(exe_path))

    def GetInstallWeixinVersion(self) -> str:
        func = self.__get_non_exported_func(self._GetInstallWeixinVersion, None, ctypes.c_bool)
        out = create_string_buffer(20)
        if func(out):
            return out.value.decode('utf-8')
        else:
            return ''


class WeChatService:
    """微信服务管理器"""
    
    def __init__(self, loader_path: str, dll_path: str):
        self.loader_path = loader_path
        self.dll_path = dll_path
        self.loader = None
        self.handler = None
        self.is_running = False
        self.should_stop = False
        self.client_id = None
        self.current_client_id = None  # 回调里真实的连接 client_id
        self.heartbeat_thread = None
        self.last_heartbeat = time.time()
        self.reconnect_attempts = 0
        self.max_reconnect_attempts = 5
        self.reconnect_delay = 10  # 秒
        
    def initialize(self):
        """初始化服务"""
        try:
            logger.info("正在初始化微信服务...")
            
            # 检查Python架构
            if is_64bit():
                logger.error("检测到64位Python，但DLL是32位的。请使用32位Python运行此程序。")
                return False
            
            # 检查文件是否存在
            if not os.path.exists(self.loader_path):
                logger.error(f"Loader DLL 文件不存在: {self.loader_path}")
                return False
                
            if not os.path.exists(self.dll_path):
                logger.error(f"Helper DLL 文件不存在: {self.dll_path}")
                return False
            
            # 创建加载器
            try:
                self.loader = NoveLoader(self.loader_path)
            except Exception as e:
                logger.error(f"创建 NoveLoader 失败: {e}")
                return False
            
            # 创建回调处理器
            self.handler = WeChatServiceHandler(self)
            self.loader.add_callback_handler(self.handler)
            
            logger.info("微信服务初始化成功")
            return True
            
        except Exception as e:
            logger.error(f"初始化微信服务失败: {e}")
            return False
    
    def start(self):
        """启动服务"""
        if not self.initialize():
            return False
            
        self.is_running = True
        self.should_stop = False
        
        try:
            # 注入微信
            logger.info("正在注入微信...")
            self.client_id = self.loader.InjectWeChat(self.dll_path)
            
            if self.client_id:
                logger.info(f"成功注入微信，客户端 ID 为: {self.client_id}")
                self.reconnect_attempts = 0
                self.last_heartbeat = time.time()  # 初始化心跳时间
                
                # 启动心跳监控
                self.start_heartbeat()
                
                # 启动主服务循环
                self.run_service()
                return True
            else:
                logger.error("注入微信失败")
                return False
                
        except Exception as e:
            logger.error(f"启动微信服务失败: {e}")
            return False
    
    def start_heartbeat(self):
        """启动心跳监控线程"""
        logger.info("心跳监控已启动")
    


    def run_service(self):
        """运行服务主循环"""
        logger.info("微信服务已启动，正在运行...")
        
        try:
            while self.is_running and not self.should_stop:
                # 检查是否需要重连
                if time.time() - self.last_heartbeat > 120:  # 2分钟无心跳
                    logger.warning("检测到连接超时，尝试重连...")
                    if self.reconnect():
                        continue
                    else:
                        break
                
                time.sleep(1)
                
        except KeyboardInterrupt:
            logger.info("收到中断信号，正在停止服务...")
            self.should_stop = True
        except Exception as e:
            logger.error(f"服务运行异常: {e}")
        finally:
            self.stop()
    
    def reconnect(self):
        """重连服务"""
        if self.reconnect_attempts >= self.max_reconnect_attempts:
            logger.error(f"重连次数超过限制 ({self.max_reconnect_attempts})，停止重连")
            return False
        
        self.reconnect_attempts += 1
        logger.info(f"尝试重连 ({self.reconnect_attempts}/{self.max_reconnect_attempts})...")
        
        try:
            # 清理当前连接
            if self.loader:
                self.loader.DestroyWeChat()
            
            time.sleep(self.reconnect_delay)
            
            # 重新注入
            self.client_id = self.loader.InjectWeChat(self.dll_path)
            if self.client_id:
                logger.info(f"重连成功，客户端 ID: {self.client_id}")
                self.last_heartbeat = time.time()
                self.reconnect_attempts = 0
                return True
            else:
                logger.error("重连失败")
                return False
                
        except Exception as e:
            logger.error(f"重连过程中发生异常: {e}")
            return False
    
    def stop(self):
        """停止服务"""
        logger.info("正在停止微信服务...")
        self.should_stop = True
        self.is_running = False
        
        try:
            if self.loader:
                self.loader.DestroyWeChat()
                logger.info("微信连接已断开")
        except Exception as e:
            logger.error(f"停止服务时发生异常: {e}")
        
        logger.info("微信服务已停止")
    
    def send_message(self, message: str, client_id: int = None):
        """发送消息"""
        if not self.loader:
            logger.error("服务未连接，无法发送消息")
            return False
        
        # 使用优先级：调用方指定 > 回调中记录的 current_client_id > 注入返回的 self.client_id > 1
        target_client_id = (
            client_id
            if client_id is not None
            else (self.current_client_id if self.current_client_id else (self.client_id if self.client_id else 1))
        )
        
        try:
            result = self.loader.SendWeChatData(target_client_id, message)
            if result:
                logger.info(f"消息发送成功 (client_id: {target_client_id}): {message}")
                return True
            else:
                logger.error(f"消息发送失败 (client_id: {target_client_id}): {result}")
                return False
        except Exception as e:
            logger.error(f"发送消息时发生异常: {e}")
            return False

    def send_startup_payload(self, room_wxid: str, status: int = 0) -> bool:
        """按需求在启动时发送一次固定结构的消息"""
        payload = {
            "data": {
                "room_wxid": room_wxid,
                "status": status
            },
            "type": 11075
        }
        message = json.dumps(payload, ensure_ascii=False)
        logger.info(f"启动消息发送: {message}")
        return self.send_message(message)


# --- SIMPLE HTTP API ---
app = Flask(__name__)

# 全局服务实例，将在主程序中初始化
_service_instance = None

def set_service_instance(service):
    """设置全局服务实例"""
    global _service_instance
    _service_instance = service

@app.route('/health', methods=['GET'])
def api_health():
    """HTTP API: 健康检查"""
    global _service_instance
    if not _service_instance:
        return jsonify({
            'status': 'error',
            'message': '服务未初始化'
        }), 500
    
    try:
        status = {
            'status': 'running' if _service_instance.is_running else 'stopped',
            'client_id': _service_instance.client_id,
            'is_running': _service_instance.is_running,
            'connected_clients': len(_service_instance.handler.connected_clients) if _service_instance.handler else 0,
            'last_heartbeat': _service_instance.last_heartbeat
        }
        return jsonify(status), 200
    except Exception as e:
        logger.error(f"/health 接口异常: {e}")
        return jsonify({'status': 'error', 'error': str(e)}), 500

@app.route('/send', methods=['POST'])
def api_send():
    """HTTP API: 接收文本或自定义 payload，转为 JSON 后调 send_message"""
    global _service_instance
    if not _service_instance:
        return jsonify({'success': False, 'error': '服务未初始化'}), 500
    
    try:
        body = request.get_json(silent=True) or {}

        # 优先支持自定义 payload: { "type": ..., "data": {...} }
        custom_type = body.get('type')
        custom_data = body.get('data')

        if custom_type is not None and isinstance(custom_data, dict):
            payload = {
                'type': custom_type,
                'data': custom_data
            }
        else:
            # 文本直发: { "text": "...", "room_wxid": "..." }
            text = body.get('text') or body.get('message')
            room_wxid = body.get('room_wxid') or "47945916190@chatroom"
            if not text:
                return jsonify({'success': False, 'error': 'text is required'}), 400

            payload = {
                'type': MessageType.MT_SEND_TEXTMSG,
                'data': {
                    'room_wxid': room_wxid,
                    'content': text
                }
            }

        message = json.dumps(payload, ensure_ascii=False)
        ok = _service_instance.send_message(message)
        return jsonify({'success': bool(ok), 'payload': payload}), (200 if ok else 500)

    except Exception as e:
        logger.error(f"/send 接口异常: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

# --- MAIN EXECUTION LOGIC ---
if __name__ == '__main__':
    # 配置 DLL 路径 - 使用项目内的 DLL 文件
    loader_path = os.path.join(SCRIPT_DIR, "Loader_4.1.2.17.dll")
    dll_path = os.path.join(SCRIPT_DIR, "Helper_4.1.2.17.dll")
    
    # 转换为绝对路径
    loader_path = os.path.abspath(loader_path)
    dll_path = os.path.abspath(dll_path)
    
    logger.info(f"Loader DLL 路径: {loader_path}")
    logger.info(f"Helper DLL 路径: {dll_path}")
    
    # 检查文件是否存在
    if not os.path.exists(loader_path):
        logger.error(f"Loader DLL 文件不存在: {loader_path}")
        sys.exit(1)
    if not os.path.exists(dll_path):
        logger.error(f"Helper DLL 文件不存在: {dll_path}")
        sys.exit(1)

    service = WeChatService(loader_path, dll_path)
    set_service_instance(service)  # 设置全局服务实例供 Flask API 使用

    # 安装信号处理器，支持 Ctrl+C (SIGINT) 与 Windows 控制台中断 (SIGBREAK)
    def _signal_handler(signum, frame):
        logger.info(f"收到信号 {signum}，准备停止服务...")
        service.should_stop = True

    signal.signal(signal.SIGINT, _signal_handler)
    if hasattr(signal, 'SIGTERM'):
        try:
            signal.signal(signal.SIGTERM, _signal_handler)
        except Exception:
            pass
    if hasattr(signal, 'SIGBREAK'):
        try:
            signal.signal(signal.SIGBREAK, _signal_handler)
        except Exception:
            pass

    # 启动服务（后台线程中运行主循环）
    t = threading.Thread(target=service.start, daemon=True)
    t.start()

    # 启动 HTTP API 服务
    api_host = os.environ.get('API_HOST', '0.0.0.0')
    api_port = int(os.environ.get('API_PORT', '5000'))
    logger.info(f"HTTP API 启动于 http://{api_host}:{api_port}")
    try:
        app.run(host=api_host, port=api_port, debug=False, use_reloader=False)
    finally:
        service.should_stop = True