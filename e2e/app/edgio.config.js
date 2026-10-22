module.exports = {
	origins: [
		{
			name: 'origin',
			hosts: [{ location: [{ hostname: 'origin' }] }],
			override_host_header: 'api.internal',
			tls_verify: { allow_self_signed_certs: true },
		},
	],
};
