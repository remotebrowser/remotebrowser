// Reject suspicious characters: '/', '?', '#' and '%'
const EMAIL_PATTERN = /^[^\s@/?#%]+@[^\s@/?#%.]+(\.[^\s@/?#%.]+)+$/;

// RFC 5321 4.5.3.1.3 caps the total mailbox length at 254 octets.
const EMAIL_MAX_LENGTH = 254;

const isEmailAddress = (value) =>
  typeof value === 'string' && value.length <= EMAIL_MAX_LENGTH && EMAIL_PATTERN.test(value);

export { isEmailAddress };
