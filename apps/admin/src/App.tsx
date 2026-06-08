import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Modal,
  Radio,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import './App.css';

const { Title, Text } = Typography;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AdminUser {
  id: string;
  email: string;
  properties: Record<string, unknown>;
  status: string;
  created_at: number;
  disk_usage_bytes: number;
  is_demo: boolean;
  demo_expires_at: number | null;
  has_freetrial: boolean;
}

type UserTypeFilter = 'all' | 'real' | 'demo' | 'freetrial';

interface AdminInvitation {
  id: string;
  email: string;
  token: string;
  status: 'pending' | 'elapsed' | 'accepted';
  created_at: number;
  accepted_at: number | null;
  warning?: string;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

function useAdminApi(baseUrl: string, token: string | null) {
  const headers = useCallback(
    (): HeadersInit => ({
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }),
    [token],
  );

  const login = useCallback(
    async (username: string, password: string): Promise<{ token: string }> => {
      const res = await fetch(`${baseUrl}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Login failed (${res.status})`);
      }
      return res.json() as Promise<{ token: string }>;
    },
    [baseUrl],
  );

  const fetchUsers = useCallback(async (): Promise<AdminUser[]> => {
    const res = await fetch(`${baseUrl}/api/admin/users`, { headers: headers() });
    if (!res.ok) throw new Error('Failed to fetch users');
    return res.json() as Promise<AdminUser[]>;
  }, [baseUrl, headers]);

  const fetchInvitations = useCallback(async (): Promise<AdminInvitation[]> => {
    const res = await fetch(`${baseUrl}/api/admin/invitations`, { headers: headers() });
    if (!res.ok) throw new Error('Failed to fetch invitations');
    return res.json() as Promise<AdminInvitation[]>;
  }, [baseUrl, headers]);

  const createInvitation = useCallback(
    async (email: string): Promise<AdminInvitation> => {
      const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
      const inviteToken = Array.from(tokenBytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;

      // Signing keypair is not available in the standalone admin app; the API
      // accepts invitations without a signature.
      const body: Record<string, unknown> = { email, token: inviteToken, expires_at: expiresAt };

      const res = await fetch(`${baseUrl}/api/admin/invitations`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        throw new Error((b as { error?: string }).error ?? `Failed to create invitation (${res.status})`);
      }
      return res.json() as Promise<AdminInvitation>;
    },
    [baseUrl, headers],
  );

  const deleteInvitation = useCallback(
    async (id: string): Promise<void> => {
      const res = await fetch(`${baseUrl}/api/admin/invitations/${id}`, {
        method: 'DELETE',
        headers: headers(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Failed to delete invitation (${res.status})`);
      }
    },
    [baseUrl, headers],
  );

  const deleteUser = useCallback(
    async (id: string): Promise<void> => {
      const res = await fetch(`${baseUrl}/api/admin/users/${id}`, {
        method: 'DELETE',
        headers: headers(),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `Failed to delete user (${res.status})`);
      }
    },
    [baseUrl, headers],
  );

  return { login, fetchUsers, fetchInvitations, createInvitation, deleteInvitation, deleteUser };
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const STATUS_COLORS: Record<string, string> = {
  pending: 'blue',
  accepted: 'green',
  elapsed: 'default',
  active: 'green',
};

// ---------------------------------------------------------------------------
// Admin Login
// ---------------------------------------------------------------------------

interface AdminLoginProps {
  onLogin: (token: string) => void;
  api: ReturnType<typeof useAdminApi>;
  baseUrl: string;
  onSetBaseUrl: (url: string) => void;
}

const AdminLogin: React.FC<AdminLoginProps> = ({ onLogin, api, baseUrl, onSetBaseUrl }) => {
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(values: { apiUrl: string; username: string; password: string }) {
    const trimmedUrl = values.apiUrl.replace(/\/$/, '');
    onSetBaseUrl(trimmedUrl);
    setError(null);
    setLoading(true);
    try {
      const { token } = await api.login(values.username, values.password);
      onLogin(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="admin-login">
      <Card>
        <Title level={3} style={{ textAlign: 'center', marginBottom: 8 }}>
          Ubimate Admin
        </Title>
        {error && (
          <Alert type="error" message={error} showIcon closable onClose={() => setError(null)} style={{ marginBottom: 16 }} />
        )}
        <Form
          layout="vertical"
          onFinish={handleSubmit}
          requiredMark={false}
          initialValues={{ apiUrl: baseUrl }}
        >
          <Form.Item name="apiUrl" label="API URL" rules={[{ required: true, message: 'Enter the API server URL' }]}>
            <Input placeholder="https://app.ubimate.com" autoComplete="off" />
          </Form.Item>
          <Form.Item name="username" label="Username" rules={[{ required: true, message: 'Enter admin username' }]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true, message: 'Enter admin password' }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block loading={loading}>
            Sign in
          </Button>
        </Form>
      </Card>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Admin Dashboard
// ---------------------------------------------------------------------------

const AdminDashboard: React.FC<{ api: ReturnType<typeof useAdminApi>; onLogout: () => void }> = ({
  api,
  onLogout,
}) => {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [invitations, setInvitations] = useState<AdminInvitation[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingInvitations, setLoadingInvitations] = useState(true);
  const [userTypeFilter, setUserTypeFilter] = useState<UserTypeFilter>('all');
  const [inviteModalOpen, setInviteModalOpen] = useState(false);
  const [inviteLoading, setInviteLoading] = useState(false);
  const [inviteForm] = Form.useForm();
  const [messageApi, contextHolder] = message.useMessage();

  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      setUsers(await api.fetchUsers());
    } catch {
      messageApi.error('Failed to load users');
    } finally {
      setLoadingUsers(false);
    }
  }, [api, messageApi]);

  const loadInvitations = useCallback(async () => {
    setLoadingInvitations(true);
    try {
      setInvitations(await api.fetchInvitations());
    } catch {
      messageApi.error('Failed to load invitations');
    } finally {
      setLoadingInvitations(false);
    }
  }, [api, messageApi]);

  useEffect(() => {
    void loadUsers();
    void loadInvitations();
  }, [loadUsers, loadInvitations]);

  async function handleCreateInvitation(values: { email: string }) {
    setInviteLoading(true);
    try {
      const inv = await api.createInvitation(values.email);
      if (inv.warning) {
        messageApi.warning(inv.warning);
      } else {
        messageApi.success(`Invitation sent to ${values.email}`);
      }
      setInviteModalOpen(false);
      inviteForm.resetFields();
      void loadInvitations();
    } catch (err) {
      messageApi.error(err instanceof Error ? err.message : 'Failed to create invitation');
    } finally {
      setInviteLoading(false);
    }
  }

  async function handleDeleteInvitation(id: string) {
    try {
      await api.deleteInvitation(id);
      messageApi.success('Invitation deleted');
      void loadInvitations();
    } catch (err) {
      messageApi.error(err instanceof Error ? err.message : 'Failed to delete invitation');
    }
  }

  function confirmDeleteUser(user: AdminUser) {
    Modal.confirm({
      title: 'Delete user',
      content: `Are you sure you want to delete ${user.email}? This will permanently remove the account and all their data.`,
      okText: 'Delete',
      okType: 'danger',
      onOk: async () => {
        try {
          await api.deleteUser(user.id);
          messageApi.success(`User ${user.email} deleted`);
          void loadUsers();
        } catch (err) {
          messageApi.error(err instanceof Error ? err.message : 'Failed to delete user');
        }
      },
    });
  }

  const filteredUsers = users.filter((u) => {
    if (userTypeFilter === 'real')      return !u.is_demo;
    if (userTypeFilter === 'demo')      return u.is_demo;
    if (userTypeFilter === 'freetrial') return u.is_demo && u.has_freetrial;
    return true;
  });

  const userColumns = [
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
    },
    {
      title: 'Name',
      key: 'name',
      render: (_: unknown, record: AdminUser) =>
        (record.properties as { name?: string }).name ?? '—',
    },
    {
      title: 'Type',
      key: 'type',
      render: (_: unknown, record: AdminUser) => {
        if (!record.is_demo) return null;
        if (record.has_freetrial) return <Tag color="purple">free trial</Tag>;
        return <Tag color="orange">demo</Tag>;
      },
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => <Tag color={STATUS_COLORS[status] ?? 'default'}>{status}</Tag>,
    },
    {
      title: 'Expires',
      key: 'demo_expires_at',
      render: (_: unknown, record: AdminUser) =>
        record.demo_expires_at ? formatDate(record.demo_expires_at) : '—',
      sorter: (a: AdminUser, b: AdminUser) =>
        (a.demo_expires_at ?? 0) - (b.demo_expires_at ?? 0),
    },
    {
      title: 'Disk usage',
      dataIndex: 'disk_usage_bytes',
      key: 'disk_usage_bytes',
      render: (bytes: number) => formatBytes(bytes),
      sorter: (a: AdminUser, b: AdminUser) => a.disk_usage_bytes - b.disk_usage_bytes,
    },
    {
      title: 'Registered',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (ts: number) => formatDate(ts),
      sorter: (a: AdminUser, b: AdminUser) => a.created_at - b.created_at,
    },
    {
      title: '',
      key: 'actions',
      render: (_: unknown, record: AdminUser) => (
        <Button type="link" danger size="small" onClick={() => confirmDeleteUser(record)}>
          Delete
        </Button>
      ),
    },
  ];

  const invitationColumns = [
    {
      title: 'Email',
      dataIndex: 'email',
      key: 'email',
    },
    {
      title: 'Token',
      dataIndex: 'token',
      key: 'token',
      render: (token: string) => (
        <Tooltip title="Click to copy">
          <Text
            className="admin-token-display"
            copyable={{ text: token }}
            ellipsis
          >
            {token.slice(0, 16)}…
          </Text>
        </Tooltip>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      render: (status: string) => <Tag color={STATUS_COLORS[status] ?? 'default'}>{status}</Tag>,
    },
    {
      title: 'Sent',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (ts: number) => formatDate(ts),
      sorter: (a: AdminInvitation, b: AdminInvitation) => a.created_at - b.created_at,
    },
    {
      title: 'Accepted',
      dataIndex: 'accepted_at',
      key: 'accepted_at',
      render: (ts: number | null) => (ts ? formatDate(ts) : '—'),
    },
    {
      title: '',
      key: 'actions',
      render: (_: unknown, record: AdminInvitation) =>
        record.status === 'pending' || record.status === 'elapsed' ? (
          <Button
            type="link"
            danger
            size="small"
            onClick={() => void handleDeleteInvitation(record.id)}
          >
            Delete
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="admin-page">
      {contextHolder}
      <div className="admin-header">
        <Title level={2}>Ubimate Admin</Title>
        <Button onClick={onLogout}>Sign out</Button>
      </div>

      <Card
        title="Users"
        className="admin-section"
        extra={
          <Radio.Group
            value={userTypeFilter}
            onChange={(e) => setUserTypeFilter(e.target.value as UserTypeFilter)}
            size="small"
          >
            <Radio.Button value="all">All ({users.length})</Radio.Button>
            <Radio.Button value="real">Real ({users.filter(u => !u.is_demo).length})</Radio.Button>
            <Radio.Button value="demo">Demo ({users.filter(u => u.is_demo).length})</Radio.Button>
            <Radio.Button value="freetrial">Free trial ({users.filter(u => u.is_demo && u.has_freetrial).length})</Radio.Button>
          </Radio.Group>
        }
      >
        <Table
          dataSource={filteredUsers}
          columns={userColumns}
          rowKey="id"
          loading={loadingUsers}
          pagination={false}
          size="small"
        />
      </Card>

      <Card
        title="Invitations"
        className="admin-section"
        extra={
          <Button type="primary" onClick={() => setInviteModalOpen(true)}>
            Send invitation
          </Button>
        }
      >
        <Table
          dataSource={invitations}
          columns={invitationColumns}
          rowKey="id"
          loading={loadingInvitations}
          pagination={false}
          size="small"
        />
      </Card>

      <Modal
        title="Send invitation"
        open={inviteModalOpen}
        onCancel={() => {
          setInviteModalOpen(false);
          inviteForm.resetFields();
        }}
        footer={null}
      >
        <Form form={inviteForm} layout="vertical" onFinish={handleCreateInvitation} requiredMark={false}>
          <Form.Item
            name="email"
            label="Email address"
            rules={[{ required: true, type: 'email', message: 'Enter a valid email address' }]}
          >
            <Input placeholder="user@example.com" autoCapitalize="off" autoCorrect="off" />
          </Form.Item>
          <Space>
            <Button type="primary" htmlType="submit" loading={inviteLoading}>
              Send
            </Button>
            <Button onClick={() => { setInviteModalOpen(false); inviteForm.resetFields(); }}>
              Cancel
            </Button>
          </Space>
        </Form>
      </Modal>
    </div>
  );
};

// ---------------------------------------------------------------------------
// App (top-level)
// ---------------------------------------------------------------------------

export default function App() {
  const [baseUrl, setBaseUrl] = useState<string>(() => {
    const stored = localStorage.getItem('ubimate_admin_url');
    // Default to the current origin so the app works out-of-the-box when
    // served by the API server at /admin.
    return stored ?? window.location.origin;
  });

  const [token, setToken] = useState<string | null>(() =>
    sessionStorage.getItem('ubimate_admin_token'),
  );

  function handleLogin(t: string) {
    sessionStorage.setItem('ubimate_admin_token', t);
    setToken(t);
  }

  function handleLogout() {
    sessionStorage.removeItem('ubimate_admin_token');
    setToken(null);
  }

  function handleSetBaseUrl(url: string) {
    localStorage.setItem('ubimate_admin_url', url);
    setBaseUrl(url);
  }

  const api = useAdminApi(baseUrl, token);

  if (!token) {
    return (
      <AdminLogin
        onLogin={handleLogin}
        api={api}
        baseUrl={baseUrl}
        onSetBaseUrl={handleSetBaseUrl}
      />
    );
  }

  return <AdminDashboard api={api} onLogout={handleLogout} />;
}
