import { redirect } from 'next/navigation';

const UnknownPage = () => {
  redirect('/');
};

export default UnknownPage;
