let sessionToken: string | null = null;

export const sessionCredential = {
  get: () => sessionToken,
  set: (token: string | null) => {
    sessionToken = token;
  },
};
