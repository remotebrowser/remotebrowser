import { ROLE_RANK } from '../../middleware/workspace.js';

// Owner outranks all; others need strictly higher rank.
const outranks = ({ actingRole, targetRole }) =>
  actingRole === 'Owner' || ROLE_RANK[actingRole] > ROLE_RANK[targetRole];

// Form-field target public id; a bad shape fails the user lookup and 400s there.
const canTransferOwnership = ({ actingUserPublicId, targetPublicId }) => targetPublicId !== actingUserPublicId;

export { outranks, canTransferOwnership };
