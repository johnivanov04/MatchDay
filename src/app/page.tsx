import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth/session';

export default async function RootPage() {
  const user = await getSessionUser();
  redirect(user === null ? '/sign-in' : '/dashboard');
}
