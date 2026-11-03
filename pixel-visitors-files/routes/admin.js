const express = require('express');
const router = express.Router();
const { requireAdmin } = require('../middleware/admin');
const retell = require('../services/retell');
const User = require('../models/User');
const AgentChangeRequest = require('../models/AgentChangeRequest');
const audiencelab = require('../services/audiencelab');

function escapeHtmlText(s) {
  if (s == null || s === '') return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// List all users
router.get('/users', requireAdmin, async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    
    // Get all agents for count
    let agents = [];
    try {
      agents = await retell.listAgents();
    } catch (e) {
      console.error('Failed to fetch agents:', e);
    }
    
    // Create agent name map
    const agentNameMap = {};
    agents.forEach(a => {
      agentNameMap[a.agent_id] = a.agent_name || a.agent_id.substring(0, 12);
    });
    
    const enrichedUsers = users.map(u => ({
      ...u.toObject(),
      agentCount: u.assignedAgentIds?.length || 0,
      agentNames: (u.assignedAgentIds || [])
        .slice(0, 3)
        .map(id => agentNameMap[id] || id.substring(0, 8))
    }));
    
    res.render('admin/users', {
      title: 'User Management',
      users: enrichedUsers,
      passwordUpdated: req.query.pw === '1',
      userCreated: req.query.created === '1',
      error: null
    });
  } catch (error) {
    console.error('Admin users error:', error);
    res.render('admin/users', {
      title: 'User Management',
      users: [],
      passwordUpdated: false,
      userCreated: false,
      error: 'Failed to load users.'
    });
  }
});

// Escape a value for safe use inside an HTML attribute
function escapeAttr(s) {
  return escapeHtmlText(s)
    .split('"').join('&quot;')
    .split("'").join('&#39;');
}

async function renderNewUserForm(res, form, error) {
  let agents = [];
  try {
    agents = await retell.listAgents();
  } catch (e) {
    console.error('Failed to load agents for the new user form:', e);
  }

  return res.render('admin/new-user', {
    title: 'Add User',
    agents,
    form: {
      name: escapeAttr(form.name || ''),
      email: escapeAttr(form.email || ''),
      role: form.role === 'admin' ? 'admin' : 'user',
      agentIds: form.agentIds || []
    },
    error: error || null
  });
}

// Show the "add user" form (admin creates the account directly)
router.get('/users/new', requireAdmin, async (req, res) => {
  try {
    return await renderNewUserForm(res, { name: '', email: '', role: 'user', agentIds: [] }, null);
  } catch (error) {
    console.error('New user form error:', error);
    return res.redirect('/admin/users');
  }
});

// Create the user
router.post('/users/new', requireAdmin, async (req, res) => {
  const name = (req.body.name || '').trim();
  const email = (req.body.email || '').trim().toLowerCase();
  const password = (req.body.password || '').trim();
  const confirmPassword = (req.body.confirmPassword || '').trim();
  const role = req.body.role === 'admin' ? 'admin' : 'user';

  let agentIds = req.body.agents || [];
  if (!Array.isArray(agentIds)) {
    agentIds = [agentIds];
  }

  const form = { name, email, role, agentIds };

  try {
    if (!name || !email || !password || !confirmPassword) {
      return await renderNewUserForm(res, form, 'Name, email and password are all required.');
    }

    if (email.indexOf('@') < 1 || email.indexOf('.') < 0) {
      return await renderNewUserForm(res, form, 'Please enter a valid email address.');
    }

    if (password.length < 8) {
      return await renderNewUserForm(res, form, 'Password must be at least 8 characters.');
    }

    if (password !== confirmPassword) {
      return await renderNewUserForm(res, form, 'Passwords do not match.');
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return await renderNewUserForm(res, form, 'A user with that email already exists.');
    }

    // Plaintext is assigned here on purpose; the User pre-save hook hashes it.
    const newUser = new User({
      name,
      email,
      passwordHash: password,
      role,
      assignedAgentIds: agentIds
    });

    await newUser.save();

    return res.redirect('/admin/users?created=1');
  } catch (error) {
    console.error('Admin create user error:', error);
    const duplicate = error && (error.code === 11000 || error.code === '11000');
    return renderNewUserForm(
      res,
      form,
      duplicate ? 'A user with that email already exists.' : 'Failed to create the user. Please try again.'
    );
  }
});

// Assign agents to user
router.get('/users/:userId/assign', requireAdmin, async (req, res) => {
  try {
    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) {
      return res.status(404).render('error', {
        title: 'User Not Found',
        message: 'The user you are looking for does not exist.'
      });
    }
    
    const agents = await retell.listAgents();
    const assignedIds = targetUser.assignedAgentIds || [];
    
    const agentsWithStatus = agents.map(agent => ({
      ...agent,
      isAssigned: assignedIds.includes(agent.agent_id)
    }));
    
    let pixels = [];
    try {
      pixels = await audiencelab.knownPixels();
    } catch (e) {
      console.error('Failed to load known pixels:', e);
    }
    // Which account already owns each pixel, so the admin can see conflicts
    const owners = await User.find({ assignedPixelId: { $ne: null } }).select('name assignedPixelId').lean();
    const ownerMap = {};
    owners.forEach(o => { ownerMap[o.assignedPixelId] = o.name; });

    res.render('admin/assign', {
      title: 'Assign Agents',
      targetUser: targetUser.toObject(),
      agents: agentsWithStatus,
      pixels: pixels.map(p => ({
        id: escapeAttr(p._id),
        visitors: p.visitors,
        owner: ownerMap[p._id] && ownerMap[p._id] !== targetUser.name ? escapeAttr(ownerMap[p._id]) : ''
      })),
      currentPixelId: escapeAttr(targetUser.assignedPixelId || ''),
      currentPixelLabel: escapeAttr(targetUser.pixelLabel || ''),
      webhookConfigured: !!process.env.AUDIENCELAB_WEBHOOK_SECRET
    });
  } catch (error) {
    console.error('Assign agents error:', error);
    res.render('error', {
      title: 'Error',
      message: 'Failed to load agent assignment page.'
    });
  }
});

// Save agent assignments
router.post('/users/:userId/assign', requireAdmin, async (req, res) => {
  try {
    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) {
      return res.status(404).render('error', {
        title: 'User Not Found',
        message: 'The user you are looking for does not exist.'
      });
    }
    
    // Get selected agent IDs from form
    let agentIds = req.body.agents || [];
    if (!Array.isArray(agentIds)) {
      agentIds = [agentIds];
    }
    
    // Update user
    targetUser.assignedAgentIds = agentIds;

    // Pixel: a manually typed ID wins over the dropdown
    const pixelId = String(req.body.pixelIdManual || req.body.pixelId || '').trim();
    targetUser.assignedPixelId = pixelId || null;
    targetUser.pixelLabel = String(req.body.pixelLabel || '').trim().slice(0, 100);

    await targetUser.save();
    
    res.redirect('/admin/users');
  } catch (error) {
    console.error('Save assignment error:', error);
    res.render('error', {
      title: 'Error',
      message: 'Failed to save agent assignments.'
    });
  }
});

// Set / reset user password (admin)
router.get('/users/:userId/password', requireAdmin, async (req, res) => {
  try {
    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) {
      return res.status(404).render('error', {
        title: 'User Not Found',
        message: 'The user you are looking for does not exist.'
      });
    }

    res.render('admin/set-password', {
      title: 'Set password',
      targetUser: targetUser.toObject(),
      error: null
    });
  } catch (error) {
    console.error('Admin set password page error:', error);
    res.redirect('/admin/users');
  }
});

router.post('/users/:userId/password', requireAdmin, async (req, res) => {
  try {
    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) {
      return res.status(404).render('error', {
        title: 'User Not Found',
        message: 'The user you are looking for does not exist.'
      });
    }

    const newPassword = (req.body.newPassword || '').trim();
    const confirmPassword = (req.body.confirmPassword || '').trim();

    if (!newPassword || newPassword.length < 8) {
      return res.render('admin/set-password', {
        title: 'Set password',
        targetUser: targetUser.toObject(),
        error: 'Password must be at least 8 characters.'
      });
    }

    if (newPassword !== confirmPassword) {
      return res.render('admin/set-password', {
        title: 'Set password',
        targetUser: targetUser.toObject(),
        error: 'Passwords do not match.'
      });
    }

    // Assign plaintext; User pre-save hook hashes passwordHash
    targetUser.passwordHash = newPassword;
    await targetUser.save();

    return res.redirect('/admin/users?pw=1');
  } catch (error) {
    console.error('Admin set password error:', error);
    const targetUser = await User.findById(req.params.userId);
    if (targetUser) {
      return res.render('admin/set-password', {
        title: 'Set password',
        targetUser: targetUser.toObject(),
        error: 'Failed to update password. Please try again.'
      });
    }
    return res.redirect('/admin/users');
  }
});

// Toggle user role
router.post('/users/:userId/toggle-role', requireAdmin, async (req, res) => {
  try {
    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Don't allow demoting yourself
    if (targetUser._id.toString() === req.session.user.id) {
      return res.redirect('/admin/users');
    }
    
    targetUser.role = targetUser.role === 'admin' ? 'user' : 'admin';
    await targetUser.save();
    
    res.redirect('/admin/users');
  } catch (error) {
    console.error('Toggle role error:', error);
    res.redirect('/admin/users');
  }
});

// Delete user
router.post('/users/:userId/delete', requireAdmin, async (req, res) => {
  try {
    const targetUser = await User.findById(req.params.userId);
    if (!targetUser) {
      return res.redirect('/admin/users');
    }
    
    // Don't allow deleting yourself
    if (targetUser._id.toString() === req.session.user.id) {
      return res.redirect('/admin/users');
    }
    
    await User.findByIdAndDelete(req.params.userId);
    
    res.redirect('/admin/users');
  } catch (error) {
    console.error('Delete user error:', error);
    res.redirect('/admin/users');
  }
});

// List all agent change requests (support ticket history: pending + completed)
router.get('/agent-change-requests', requireAdmin, async (req, res) => {
  try {
    const requests = await AgentChangeRequest.find({})
      .sort({ createdAt: -1 })
      .populate('userId', 'name email role')
      .populate('completedBy', 'name email')
      .lean();

    // Pending first, then newest first within each group
    requests.sort((a, b) => {
      if (a.status === 'pending' && b.status !== 'pending') return -1;
      if (a.status !== 'pending' && b.status === 'pending') return 1;
      return new Date(b.createdAt) - new Date(a.createdAt);
    });

    const allAgents = await retell.listAgents();
    const agentNameMap = {};
    allAgents.forEach(a => {
      agentNameMap[a.agent_id] = a.agent_name || a.agent_id.substring(0, 12);
    });

    const NOTE_PREVIEW_LEN = 120;
    const mappedRequests = requests.map(r => {
      const rawReason = r.reason || '';
      const long = rawReason.length > NOTE_PREVIEW_LEN;
      return {
        ...r,
        user: r.userId,
        completedByUser: r.completedBy,
        reasonEscaped: escapeHtmlText(rawReason),
        reasonPreviewEscaped: escapeHtmlText(
          long ? `${rawReason.slice(0, NOTE_PREVIEW_LEN)}…` : rawReason
        ),
        reasonIsLong: long
      };
    });

    res.render('admin/agentChangeRequests/index', {
      title: 'Agent Change Requests',
      requests: mappedRequests,
      agentNameMap,
      error: null
    });
  } catch (error) {
    console.error('Agent change requests error:', error);
    res.render('admin/agentChangeRequests/index', {
      title: 'Agent Change Requests',
      requests: [],
      agentNameMap: {},
      error: 'Failed to load requests.'
    });
  }
});

// Complete a pending request (admin action)
router.post('/agent-change-requests/:requestId/complete', requireAdmin, async (req, res) => {
  try {
    const adminId = req.session.user.id;

    const request = await AgentChangeRequest.findById(req.params.requestId);
    if (!request) {
      return res.status(404).render('error', {
        title: 'Request Not Found',
        message: 'The agent change request does not exist.'
      });
    }

    if (request.status !== 'pending') {
      return res.redirect('/admin/agent-change-requests');
    }

    // Update the target user's assigned agents.
    await User.findByIdAndUpdate(request.userId, {
      $set: {
        assignedAgentIds: [request.requestedAgentId]
      }
    });

    // Mark request as completed.
    request.status = 'completed';
    request.completedAt = new Date();
    request.completedBy = adminId;
    await request.save();

    return res.redirect('/admin/agent-change-requests');
  } catch (error) {
    console.error('Complete agent change request error:', error);
    return res.redirect('/admin/agent-change-requests');
  }
});

module.exports = router;

