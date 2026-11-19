// 'active' leaves out terminated browsers, which never change again.
export const STATUS_FILTERS = ['active', 'all', 'starting', 'running', 'suspended', 'error', 'terminated'];

export const readStatusFilter = (c) => {
  const status = c.req.query('status');
  return STATUS_FILTERS.includes(status) ? status : 'active';
};

export const matchesStatusFilter = (filter, status) => {
  if (filter === 'all') return true;
  if (filter === 'active') return status !== 'terminated';
  return status === filter;
};

export const statusFilterQuery = (filter) => (filter === 'active' ? '' : `?status=${filter}`);
