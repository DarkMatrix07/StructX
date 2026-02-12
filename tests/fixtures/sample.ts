import { hash } from 'crypto';

export function validateEmail(email: string): boolean {
  const regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return regex.test(email);
}

export async function login(email: string, password: string): Promise<{ id: string; email: string }> {
  const valid = validateEmail(email);
  if (!valid) throw new Error('Invalid email');

  const hashed = hashPassword(password);
  const user = await findUser(email, hashed);
  if (!user) throw new Error('Invalid credentials');

  await createSession(user.id);
  return user;
}

function hashPassword(password: string): string {
  return password; // placeholder
}

async function findUser(email: string, hashedPassword: string): Promise<{ id: string; email: string } | null> {
  return { id: '1', email };
}

const createSession = async (userId: string): Promise<void> => {
  console.log(`Session created for ${userId}`);
};

export class AuthService {
  async authenticate(email: string, password: string) {
    return login(email, password);
  }

  logout(userId: string): void {
    console.log(`Logged out ${userId}`);
  }
}
