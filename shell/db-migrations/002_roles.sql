-- ============================================================================
-- 002_roles.sql —— RBAC 角色权限表
-- ----------------------------------------------------------------------------
-- 为权限系统添加角色定义表
-- ============================================================================

-- 角色表：存储角色及其权限集合
CREATE TABLE IF NOT EXISTS roles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL UNIQUE,           -- 角色名称
  permissions   JSONB NOT NULL,                 -- 权限列表（JSON 数组）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 更新 users 表的 role 字段，使其引用 roles 表
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'member';

-- 添加更新时间戳的触发器
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_roles_updated_at 
    BEFORE UPDATE ON roles 
    FOR EACH ROW 
    EXECUTE FUNCTION update_updated_at_column();