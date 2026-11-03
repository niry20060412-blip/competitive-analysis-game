-- 用量统计表：每天一条记录，累计当天的调用次数
CREATE TABLE IF NOT EXISTS usage_daily (
  day TEXT PRIMARY KEY,        -- 日期，格式 YYYY-MM-DD（UTC）
  search_count INTEGER DEFAULT 0,   -- 搜索调用次数（/api/search）
  summarize_count INTEGER DEFAULT 0, -- AI 整理调用次数（/api/summarize）
  input_tokens INTEGER DEFAULT 0,   -- 估算输入 token
  output_tokens INTEGER DEFAULT 0,  -- 估算输出 token
  updated_at TEXT
);
