<?php
/**
 * Plan 3 Dedicated AST/Token Transformer (Universal Namespace-Aware Mangling Engine)
 * 
 * Features:
 * 1. 100% Comment and DocBlock stripping (preserves main plugin header).
 * 2. Internal Function Mangling (_f_...).
 * 3. Internal Class & FQCN Mangling (_c_...).
 * 4. Class Constant Mangling (_k_...).
 * 5. Private Method & Private Property Mangling (_m_..., _p_...).
 * 6. Local Variable Mangling ($_v_...).
 * 7. 100% Byte-exact preservation of string literals, SQL, HTML, and gettext (%1$s).
 * 8. Safe whitespace compaction.
 */

class Plan3_Transformer {

	protected $seed;
	public $function_map = array();
	public $class_map    = array();
	public $constant_map = array();
	public $class_kinds  = array();
	public $scoped_function_map   = array();
	public $global_function_map   = array();
	public $function_declarations = array();
	protected $short_func_counts  = array();

	protected static $reserved_vars = array(
		'$this',
		'$_GET',
		'$_POST',
		'$_COOKIE',
		'$_REQUEST',
		'$_SERVER',
		'$_ENV',
		'$_FILES',
		'$_SESSION',
		'$GLOBALS',
		'$wpdb',
		'$wp_query',
		'$post',
		'$wp_version',
		'$menu',
		'$submenu',
		'$admin_page_hooks',
		'$pagenow',
		'$parent_file',
		'$submenu_file',
		'$plugin_page',
		'$hook_suffix',
		'$wp_filter',
		'$wp_scripts',
		'$wp_styles',
		'$wp',
		'$current_user',
		'$current_screen',
		'$wp_admin_bar',
		'$wp_roles',
		'$wp_object_cache',
		'$wp_rewrite',
		'$wp_taxonomies',
		'$wp_post_types',
		'$wp_locale',
		'$wp_embed',
		'$wp_filesystem',
		'$wp_rest_server',
		'$wp_customize',
		'$typenow',
		'$taxnow',
		'$authordata',
		'$args',
		'$messages',
		'$message',
		'$data',
		'$content',
		'$rows',
		'$product_id',
		'$is_logged_in',
		'$owns',
		'$total_lessons',
		'$test',
		'$result',
		'$submission',
		'$answers',
		'$user_name',
		'$date_formatted',
		'$font_url',
		'$is_pdf',
	);

	protected static $reserved_funcs = array(
		'add_action',
		'add_filter',
		'apply_filters',
		'do_action',
		'get_option',
		'update_option',
		'delete_option',
		'get_post_meta',
		'update_post_meta',
		'sprintf',
		'printf',
		'__',
		'_e',
		'_x',
		'_n',
		'esc_html',
		'esc_attr',
		'esc_url',
		'wp_kses_post',
		'wp_unslash',
		'defined',
		'is_readable',
		'file_exists',
		'require_once',
		'include_once',
		'require',
		'include',
		'dirname',
		'count',
		'is_array',
		'is_object',
		'is_string',
		'is_admin',
		'plugins_url',
		'plugin_dir_path',
		'plugin_dir_url',
		'class_exists',
		'function_exists',
		'did_action',
		'home_url',
		'site_url',
		'admin_url',
		'get_theme_mod',
		'get_bloginfo',
		'is_email',
		'sanitize_email',
		'sanitize_text_field',
		'sanitize_key',
		'sanitize_hex_color',
		'absint',
		'esc_url_raw',
		'esc_attr__',
		'esc_html__',
		'esc_html_e',
		'esc_attr_e',
		'register_post_meta',
		'register_setting',
		'wp_die',
	);

	protected static $frozen_public_classes = array(
		'Plugin',
		'Module',
		'ModuleInterface',
		'ModuleLoader',
		'ProductMetaKeys',
		'CourseNotificationsDisplay',
		'AppOnlyDisplay',
		'AbstractModule',
		'Base_Admin_Page',
		'List_Admin_Page',
		'Base_List_Table',
		'Edit_Admin_Page',
		'Wizard_Admin_Page',
		'Settings_Admin_Page',
		'Customizer_Admin_Page',
		'Base_Customer_Facing_Admin_Page',
		'Edit_Page_Widgets',
		'Edit_Object_Page',
		'Table',
		'Base',
		'Plan3_Transformer',
		'GiftCheckoutService',
		'GiftHistoryProjection',
		'GiftItemsRepository',
		'GiftItemsSchema',
		'GiftStatuses',
		'PrerequisiteResolver',
		'CourseOwnership',
		'BundleEntitlements',
		'StatusResolver',
		'Status',
		'Roles',
		'TicketListAdminPage',
		'NotificationManager',
		'AliasesStorage',
		'Gateway',
		'TestToken',
		'TavangaryAccess',
		'CreditEarning',
		'CreditStorage',
		'Assets',
		'SubmissionRepository',
		'TestPlayAccess',
		'TestRegistry',
		'GiftOrderItemHelper',
		'GiftMeta',
		'QuickBuyLinks',
		'Installer',
		'Plugin',
		'DashboardPage',
		'SettingsPage',
		'PassesPage',
		'NotificationsListPage',
		'CreditListPage',
		'HelpAdminPage',
		'TrainingWizardPage',
		'OnlineTestsPage',
		'SubmissionDetailPage',
		'TestAccessPage',
		'ExportPage',
		'Product_Post_Edit_Page',
		'QuickBuyPage',
		'StudentListPage',
		'StudentProfilePage',
		'SyncStatusPage',
		'UserPurchaseFilterPage',
		'UsersScreen',
		'TestUserSettings',
		'TestUser',
		'PurgeService',
		'PurgeGuard',
		'TestUsersAccess',
	);

	protected static $frozen_public_constants = array(
		'COURSE_DURATION',
		'COURSE_INSTRUCTOR',
		'COURSE_LESSONS_COUNT',
		'APP_ONLY',
		'SHOW_COURSE_NOTIFICATIONS',
		'ADD_TO_CART_TEXT',
		'HEADER_IMAGE',
		'COURSE_WHAT',
		'COURSE_WHY',
		'ACTIVE',
		'INACTIVE',
		'SEMI_ACTIVE',
		'CAP_MANAGE',
		'CAP_VIEW',
		'CAP_SENSITIVE',
		'MANAGE_SETTINGS',
		'VIEW_REPORTS',
		'SENSITIVE_SETTINGS',
		'SECTION',
		'HELP_HUB_ENABLED',
		'EXPORT_CSV',
		'MENU_SLUG',
		'CSV_ACTION',
	);

	protected static $magic_methods = array(
		'__construct',
		'__destruct',
		'__call',
		'__callStatic',
		'__get',
		'__set',
		'__isset',
		'__unset',
		'__sleep',
		'__wakeup',
		'__serialize',
		'__unserialize',
		'__toString',
		'__invoke',
		'__set_state',
		'__clone',
		'__debugInfo',
		'get_columns',
		'get_schema',
		'get_table',
		'get_items',
		'get_count',
		'get_item',
	);

	public $flatten_namespaces = true;
	protected $ambiguous_short_names = array();

	protected static $hook_api_functions = array(
		'add_action',
		'add_filter',
		'remove_action',
		'remove_filter',
		'has_action',
		'has_filter',
		'did_action',
		'doing_action',
		'doing_filter',
		'current_filter',
		'current_action',
		'do_action',
		'do_action_ref_array',
		'apply_filters',
		'apply_filters_ref_array',
	);

	protected static $callback_array_keys = array(
		'callback',
		'permission_callback',
		'sanitize_callback',
		'validate_callback',
		'auth_callback',
	);

	public function __construct( $seed = 'wpdev-plan3-spec', $flatten_namespaces = true ) {
		$this->seed = $seed;
		$this->flatten_namespaces = (bool) $flatten_namespaces;
		if ( function_exists( 'get_defined_functions' ) ) {
			$defined = get_defined_functions();
			if ( isset( $defined['internal'] ) && is_array( $defined['internal'] ) ) {
				self::$reserved_funcs = array_unique( array_merge( self::$reserved_funcs, $defined['internal'] ) );
			}
		}
	}

	protected function prev_code_index( $tokens, $i ) {
		$p = $i - 1;
		while ( $p >= 0 && is_array( $tokens[ $p ] ) && $tokens[ $p ][0] === T_WHITESPACE ) {
			$p--;
		}
		return $p;
	}

	protected function token_function_name( $token ) {
		if ( ! is_array( $token ) ) {
			return '';
		}
		$text = $token[1];
		if ( $token[0] === T_STRING ) {
			return $text;
		}
		if ( defined( 'T_NAME_FULLY_QUALIFIED' ) && $token[0] === T_NAME_FULLY_QUALIFIED ) {
			$parts = explode( '\\', $text );
			return end( $parts );
		}
		if ( defined( 'T_NAME_QUALIFIED' ) && $token[0] === T_NAME_QUALIFIED ) {
			$parts = explode( '\\', $text );
			return end( $parts );
		}
		return '';
	}

	protected function read_namespace_spec( $tokens, $namespace_index, $count ) {
		$j    = $namespace_index + 1;
		$name = '';
		$terminator = '';
		while ( $j < $count ) {
			$t = $tokens[ $j ];
			if ( is_string( $t ) ) {
				if ( $t === ';' || $t === '{' ) {
					$terminator = $t;
					break;
				}
				if ( $t === '\\' ) {
					$name .= '\\';
					$j++;
					continue;
				}
				break;
			}
			if ( ! is_array( $t ) ) {
				$j++;
				continue;
			}
			if ( $t[0] === T_WHITESPACE ) {
				$j++;
				continue;
			}
			if (
				$t[0] === T_STRING
				|| $t[0] === T_NS_SEPARATOR
				|| ( defined( 'T_NAME_QUALIFIED' ) && $t[0] === T_NAME_QUALIFIED )
				|| ( defined( 'T_NAME_FULLY_QUALIFIED' ) && $t[0] === T_NAME_FULLY_QUALIFIED )
			) {
				$name .= $t[1];
				$j++;
				continue;
			}
			break;
		}
		return array(
			'name'       => trim( $name, '\\' ),
			'terminator' => $terminator,
			'end'        => $j,
		);
	}

	protected function record_short_class_name( $class_name, $mangled ) {
		if ( in_array( $class_name, $this->ambiguous_short_names, true ) ) {
			return;
		}
		if ( isset( $this->class_map[ $class_name ] ) && $this->class_map[ $class_name ] !== $mangled ) {
			unset( $this->class_map[ $class_name ], $this->class_map[ '\\' . $class_name ] );
			$this->ambiguous_short_names[] = $class_name;
			return;
		}
		$this->class_map[ $class_name ]           = $mangled;
		$this->class_map[ '\\' . $class_name ] = '\\' . $mangled;
	}

	protected function is_hook_name_string( $tokens, $i ) {
		$p = $this->prev_code_index( $tokens, $i );
		if ( $p < 0 || ! is_string( $tokens[ $p ] ) || $tokens[ $p ] !== '(' ) {
			return false;
		}
		$p = $this->prev_code_index( $tokens, $p );
		if ( $p < 0 ) {
			return false;
		}
		$name = $this->token_function_name( $tokens[ $p ] );
		return $name !== '' && in_array( $name, self::$hook_api_functions, true );
	}

	protected function is_callback_key_string( $tokens, $i ) {
		$p = $this->prev_code_index( $tokens, $i );
		if ( $p < 0 || ! is_array( $tokens[ $p ] ) || $tokens[ $p ][0] !== T_DOUBLE_ARROW ) {
			return false;
		}
		$p = $this->prev_code_index( $tokens, $p );
		if ( $p < 0 || ! is_array( $tokens[ $p ] ) || $tokens[ $p ][0] !== T_CONSTANT_ENCAPSED_STRING ) {
			return false;
		}
		$key = trim( $tokens[ $p ][1], "'\"" );
		return in_array( $key, self::$callback_array_keys, true );
	}

	protected function is_array_callable_method_string( $tokens, $i ) {
		$p = $this->prev_code_index( $tokens, $i );
		if ( $p < 0 || ! is_string( $tokens[ $p ] ) || $tokens[ $p ] !== ',' ) {
			return false;
		}
		$p = $this->prev_code_index( $tokens, $p );
		if ( $p < 0 ) {
			return false;
		}
		$looks_like_target = false;
		if ( is_array( $tokens[ $p ] ) ) {
			$id = $tokens[ $p ][0];
			if (
				$id === T_VARIABLE
				|| $id === T_CLASS_C
				|| $id === T_STATIC
				|| $id === T_CLASS
				|| $id === T_STRING
				|| $id === T_CONSTANT_ENCAPSED_STRING
				|| ( defined( 'T_NAME_FULLY_QUALIFIED' ) && $id === T_NAME_FULLY_QUALIFIED )
				|| ( defined( 'T_NAME_QUALIFIED' ) && $id === T_NAME_QUALIFIED )
			) {
				$looks_like_target = true;
			}
		}
		if ( ! $looks_like_target ) {
			return false;
		}
		$p = $this->prev_code_index( $tokens, $p );
		while ( $p >= 0 ) {
			$t = $tokens[ $p ];
			if ( is_array( $t ) && $t[0] === T_WHITESPACE ) {
				$p--;
				continue;
			}
			if ( is_string( $t ) && $t === '[' ) {
				return true;
			}
			if ( is_string( $t ) && $t === '(' ) {
				$q = $this->prev_code_index( $tokens, $p );
				return $q >= 0 && is_array( $tokens[ $q ] ) && $tokens[ $q ][0] === T_ARRAY;
			}
			if (
				is_array( $t )
				&& (
					$t[0] === T_DOUBLE_COLON
					|| $t[0] === T_STRING
					|| $t[0] === T_NS_SEPARATOR
					|| $t[0] === T_STATIC
					|| ( defined( 'T_NAME_FULLY_QUALIFIED' ) && $t[0] === T_NAME_FULLY_QUALIFIED )
					|| ( defined( 'T_NAME_QUALIFIED' ) && $t[0] === T_NAME_QUALIFIED )
				)
			) {
				$p = $this->prev_code_index( $tokens, $p );
				continue;
			}
			break;
		}
		return false;
	}

	protected function is_gettext_string( $tokens, $i ) {
		$p = $this->prev_code_index( $tokens, $i );
		if ( $p < 0 || ! is_string( $tokens[ $p ] ) || ( $tokens[ $p ] !== '(' && $tokens[ $p ] !== ',' ) ) {
			return false;
		}
		while ( $p >= 0 && is_string( $tokens[ $p ] ) && $tokens[ $p ] !== '(' ) {
			$p = $this->prev_code_index( $tokens, $p );
		}
		if ( $p < 0 || ! is_string( $tokens[ $p ] ) || $tokens[ $p ] !== '(' ) {
			return false;
		}
		$fn_idx = $this->prev_code_index( $tokens, $p );
		if ( $fn_idx < 0 ) return false;
		$fn_name = strtolower( $this->token_function_name( $tokens[ $fn_idx ] ) );
		$gettext_funcs = array( '__', '_e', '_x', 'esc_html__', 'esc_html_e', 'esc_html_x', 'esc_attr__', 'esc_attr_e', 'esc_attr_x', '_n', '_nx' );
		return in_array( $fn_name, $gettext_funcs, true );
	}

	protected function is_array_key_string( $tokens, $i, $count ) {
		$next = $i + 1;
		while ( $next < $count && is_array( $tokens[ $next ] ) && $tokens[ $next ][0] === T_WHITESPACE ) {
			$next++;
		}
		return ( $next < $count && is_array( $tokens[ $next ] ) && $tokens[ $next ][0] === T_DOUBLE_ARROW );
	}

	protected function is_reflection_or_instantiation_string( $tokens, $i ) {
		$p = $this->prev_code_index( $tokens, $i );
		if ( $p < 0 ) return false;
		if ( is_array( $tokens[ $p ] ) && $tokens[ $p ][0] === T_NEW ) {
			return true;
		}
		if ( is_string( $tokens[ $p ] ) && $tokens[ $p ] === '(' ) {
			$fn_idx = $this->prev_code_index( $tokens, $p );
			if ( $fn_idx >= 0 ) {
				$fn_name = strtolower( $this->token_function_name( $tokens[ $fn_idx ] ) );
				$reflection_funcs = array( 'class_exists', 'interface_exists', 'trait_exists', 'is_a', 'is_subclass_of', 'is_of_class' );
				return in_array( $fn_name, $reflection_funcs, true );
			}
		}
		return false;
	}

	protected function is_callback_argument_string( $tokens, $i ) {
		$p = $this->prev_code_index( $tokens, $i );
		if ( $p < 0 || ! is_string( $tokens[ $p ] ) || ( $tokens[ $p ] !== '(' && $tokens[ $p ] !== ',' ) ) {
			return false;
		}
		$depth = 0;
		while ( $p >= 0 ) {
			if ( is_string( $tokens[ $p ] ) ) {
				if ( $tokens[ $p ] === ')' ) {
					$depth++;
				} elseif ( $tokens[ $p ] === '(' ) {
					if ( $depth === 0 ) {
						break;
					}
					$depth--;
				}
			}
			$p = $this->prev_code_index( $tokens, $p );
		}
		if ( $p < 0 || ! is_string( $tokens[ $p ] ) || $tokens[ $p ] !== '(' ) return false;
		$fn_idx = $this->prev_code_index( $tokens, $p );
		if ( $fn_idx < 0 ) return false;
		$fn_name = strtolower( $this->token_function_name( $tokens[ $fn_idx ] ) );
		$callback_callers = array( 'call_user_func', 'call_user_func_array', 'add_action', 'add_filter', 'register_activation_hook', 'register_deactivation_hook', 'function_exists', 'has_action', 'has_filter', 'remove_action', 'remove_filter' );
		return in_array( $fn_name, $callback_callers, true );
	}

	protected function is_array_subscript_string( $tokens, $i ) {
		$p = $this->prev_code_index( $tokens, $i );
		return ( $p >= 0 && is_string( $tokens[ $p ] ) && $tokens[ $p ] === '[' );
	}

	protected function record_short_function_name( $func_name, $mangled ) {
		$key = strtolower( $func_name );
		if ( ! isset( $this->short_func_counts[ $key ] ) ) {
			$this->short_func_counts[ $key ] = 0;
		}
		$this->short_func_counts[ $key ]++;
		if ( $this->short_func_counts[ $key ] === 1 ) {
			$this->function_map[ $func_name ] = $mangled;
			$this->function_map[ '\\' . $func_name ] = '\\' . $mangled;
		} else {
			unset( $this->function_map[ $func_name ] );
			unset( $this->function_map[ '\\' . $func_name ] );
		}
	}

	public function resolve_function_name( $name, $current_namespace = '', $file_use_func_map = array() ) {
		$clean = ltrim( $name, '\\' );
		$lower_clean = strtolower( $clean );

		if ( isset( $file_use_func_map[ $lower_clean ] ) ) {
			$target_fqfn = $file_use_func_map[ $lower_clean ];
			if ( isset( $this->function_map[ $target_fqfn ] ) ) {
				return $this->function_map[ $target_fqfn ];
			}
			if ( isset( $this->function_map[ '\\' . $target_fqfn ] ) ) {
				return ltrim( $this->function_map[ '\\' . $target_fqfn ], '\\' );
			}
		}

		if ( ! empty( $current_namespace ) && isset( $this->scoped_function_map[ $current_namespace ][ $lower_clean ] ) ) {
			return $this->scoped_function_map[ $current_namespace ][ $lower_clean ];
		}

		if ( strpos( $clean, '\\' ) !== false ) {
			if ( isset( $this->function_map[ $clean ] ) ) {
				return $this->function_map[ $clean ];
			}
			if ( isset( $this->function_map[ '\\' . $clean ] ) ) {
				return ltrim( $this->function_map[ '\\' . $clean ], '\\' );
			}
			$last_slash = strrpos( $clean, '\\' );
			$ns = substr( $clean, 0, $last_slash );
			$short = strtolower( substr( $clean, $last_slash + 1 ) );
			if ( isset( $this->scoped_function_map[ $ns ][ $short ] ) ) {
				return $this->scoped_function_map[ $ns ][ $short ];
			}
		}

		if ( isset( $this->global_function_map[ $lower_clean ] ) ) {
			return $this->global_function_map[ $lower_clean ];
		}

		if ( isset( $this->function_map[ $clean ] ) ) {
			return $this->function_map[ $clean ];
		}
		if ( isset( $this->function_map[ '\\' . $clean ] ) ) {
			return ltrim( $this->function_map[ '\\' . $clean ], '\\' );
		}

		return null;
	}

	public function load_map_from_array( $loaded ) {
		$this->class_map    = isset( $loaded['classes'] ) && is_array( $loaded['classes'] ) ? $loaded['classes'] : array();
		$this->function_map = isset( $loaded['functions'] ) && is_array( $loaded['functions'] ) ? $loaded['functions'] : array();
		$this->constant_map = isset( $loaded['constants'] ) && is_array( $loaded['constants'] ) ? $loaded['constants'] : array();
		$this->class_kinds  = isset( $loaded['kinds'] ) && is_array( $loaded['kinds'] ) ? $loaded['kinds'] : array();

		$this->scoped_function_map = array();
		$this->global_function_map = array();
		foreach ( $this->function_map as $sym => $mangled ) {
			if ( substr( $sym, 0, 1 ) === '\\' ) {
				continue;
			}
			$clean_mangled = ltrim( $mangled, '\\' );
			if ( strpos( $sym, '\\' ) !== false ) {
				$last_slash = strrpos( $sym, '\\' );
				$ns = substr( $sym, 0, $last_slash );
				$short = strtolower( substr( $sym, $last_slash + 1 ) );
				$this->scoped_function_map[ $ns ][ $short ] = $clean_mangled;
			} else {
				$this->global_function_map[ strtolower( $sym ) ] = $clean_mangled;
			}
		}
	}

	protected function try_rewrite_compact_call( $tokens, $i, $count ) {
		$p = $this->prev_code_index( $tokens, $i );
		if ( $p >= 0 && is_array( $tokens[ $p ] ) ) {
			$prev_id = $tokens[ $p ][0];
			if ( $prev_id === T_OBJECT_OPERATOR || ( defined( 'T_NULLSAFE_OBJECT_OPERATOR' ) && $prev_id === T_NULLSAFE_OBJECT_OPERATOR ) || $prev_id === T_DOUBLE_COLON || $prev_id === T_FUNCTION ) {
				return null;
			}
		}
		$j = $i + 1;
		while ( $j < $count && is_array( $tokens[ $j ] ) && $tokens[ $j ][0] === T_WHITESPACE ) {
			$j++;
		}
		if ( $j >= $count || ! is_string( $tokens[ $j ] ) || $tokens[ $j ] !== '(' ) {
			return null;
		}
		$end          = $j + 1;
		$args         = array();
		$current      = '';
		$only_strings = true;
		$depth        = 1;
		while ( $end < $count && $depth > 0 ) {
			$t = $tokens[ $end ];
			if ( is_string( $t ) ) {
				if ( $t === '(' || $t === '[' ) {
					$depth++;
					$only_strings = false;
				} elseif ( $t === ')' || $t === ']' ) {
					$depth--;
					if ( $depth === 0 ) {
						break;
					}
					$only_strings = false;
				} elseif ( $t === ',' && $depth === 1 ) {
					$args[]  = trim( $current );
					$current = '';
				} else {
					$only_strings = false;
				}
			} elseif ( is_array( $t ) ) {
				if ( $t[0] === T_WHITESPACE || $t[0] === T_COMMENT || $t[0] === T_DOC_COMMENT ) {
					// Ignore layout inside compact().
				} elseif ( $t[0] === T_CONSTANT_ENCAPSED_STRING && $depth === 1 && $current === '' ) {
					$current = $t[1];
				} else {
					$only_strings = false;
				}
			}
			$end++;
		}
		if ( $current !== '' ) {
			$args[] = trim( $current );
		}
		if ( ! $only_strings || empty( $args ) ) {
			return null;
		}
		$pairs = array();
		foreach ( $args as $quoted ) {
			if ( $quoted === '' || ( $quoted[0] !== "'" && $quoted[0] !== '"' ) ) {
				return null;
			}
			$name = trim( $quoted, "'\"" );
			if ( $name === '' || ! preg_match( '/^[a-zA-Z_][a-zA-Z0-9_]*$/', $name ) ) {
				return null;
			}
			$dollar = '$' . $name;
			if ( in_array( $dollar, self::$reserved_vars, true ) ) {
				$pairs[] = $quoted . ' => ' . $dollar;
			} else {
				$mangled = '$_v_' . substr( hash( 'sha256', $this->seed . ':v:' . $dollar ), 0, 8 );
				$pairs[] = $quoted . ' => ' . $mangled;
			}
		}
		return array(
			'code' => 'array(' . implode( ', ', $pairs ) . ')',
			'end'  => $end,
		);
	}

	public function scan_symbols_in_dir( $dir ) {
		$this->ambiguous_short_names = array();
		$this->short_func_counts     = array();
		$this->function_declarations = array();
		$it = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $dir, RecursiveDirectoryIterator::SKIP_DOTS ) );
		foreach ( $it as $file ) {
			$pathname = str_replace( '\\', '/', $file->getPathname() );
			if ( strpos( $pathname, '/vendor/' ) !== false || strpos( $pathname, '/vendor-prefixed/' ) !== false ) {
				continue;
			}
			if ( $file->isFile() && $file->getExtension() === 'php' ) {
				$this->scan_file_symbols( $file->getPathname() );
			}
		}
	}

	public function scan_file_symbols( $file_path ) {
		$source = @file_get_contents( $file_path );
		if ( $source === false ) {
			return;
		}
		$tokens = token_get_all( $source );
		$count  = count( $tokens );

		$current_namespace = '';
		$class_depth = 0;
		$in_class = 0;
		$ns_brace_depth = 0;

		for ( $i = 0; $i < $count; $i++ ) {
			$token = $tokens[ $i ];
			if ( is_string( $token ) ) {
				if ( $token === '{' ) {
					if ( $in_class === 1 ) {
						$in_class = 2;
						$class_depth = 1;
						if ( $ns_brace_depth > 0 ) {
							$ns_brace_depth++;
						}
					} elseif ( $class_depth > 0 ) {
						$class_depth++;
						if ( $ns_brace_depth > 0 ) {
							$ns_brace_depth++;
						}
					} elseif ( $ns_brace_depth > 0 ) {
						$ns_brace_depth++;
					}
				} elseif ( $token === '}' ) {
					if ( $class_depth > 0 ) {
						$class_depth--;
						if ( $class_depth === 0 ) {
							$in_class = 0;
						}
					}
					if ( $ns_brace_depth > 0 ) {
						$ns_brace_depth--;
						if ( $ns_brace_depth === 0 ) {
							$current_namespace = '';
						}
					}
				}
				continue;
			}
			if ( is_array( $token ) ) {
				$id = $token[0];

				if ( $id === T_NAMESPACE ) {
					$spec = $this->read_namespace_spec( $tokens, $i, $count );
					$current_namespace = $spec['name'];
					if ( $spec['terminator'] === '{' ) {
						$ns_brace_depth = 1;
					}
					$i = $spec['end'];
				} elseif ( $id === T_CLASS || $id === T_INTERFACE || $id === T_TRAIT || ( defined( 'T_ENUM' ) && $id === T_ENUM ) ) {
					$in_class = 1;
					$kind = 'class';
					if ( $id === T_INTERFACE ) {
						$kind = 'interface';
					} elseif ( $id === T_TRAIT ) {
						$kind = 'trait';
					} elseif ( defined( 'T_ENUM' ) && $id === T_ENUM ) {
						$kind = 'enum';
					}
					$next = $i + 1;
					while ( $next < $count && is_array( $tokens[ $next ] ) && ( $tokens[ $next ][0] === T_WHITESPACE || $tokens[ $next ][0] === T_STATIC || $tokens[ $next ][0] === T_ABSTRACT || $tokens[ $next ][0] === T_FINAL ) ) {
						$next++;
					}
					if ( $next < $count && is_array( $tokens[ $next ] ) && $tokens[ $next ][0] === T_STRING ) {
						$class_name = $tokens[ $next ][1];
						$hash_key = ! empty( $current_namespace ) ? ( $current_namespace . '\\' . $class_name ) : $class_name;
						$this->class_kinds[ $hash_key ] = $kind;
						if ( in_array( $class_name, self::$frozen_public_classes, true ) ) {
							continue;
						}
						$mangled = '_c_' . substr( hash( 'sha256', $this->seed . ':class:' . $hash_key ), 0, 8 );

						if ( $this->flatten_namespaces ) {
							$this->record_short_class_name( $class_name, $mangled );
							if ( ! empty( $current_namespace ) ) {
								$fqcn = $current_namespace . '\\' . $class_name;
								$this->class_map[ $fqcn ] = $mangled;
								$this->class_map[ '\\' . $fqcn ] = '\\' . $mangled;
							}
						} else {
							if ( ! empty( $current_namespace ) ) {
								$fqcn = $current_namespace . '\\' . $class_name;
								$this->class_map[ $fqcn ] = $current_namespace . '\\' . $mangled;
								$this->class_map[ '\\' . $fqcn ] = '\\' . $current_namespace . '\\' . $mangled;
							} else {
								$this->class_map[ $class_name ] = $mangled;
								$this->class_map[ '\\' . $class_name ] = '\\' . $mangled;
							}
						}
					}
				} elseif ( $id === T_FUNCTION && $class_depth === 0 && $in_class === 0 ) {
					$prev = $i - 1;
					$is_method = false;
					while ( $prev >= 0 && is_array( $tokens[ $prev ] ) && ( $tokens[ $prev ][0] === T_WHITESPACE || $tokens[ $prev ][0] === T_STATIC || $tokens[ $prev ][0] === T_FINAL || ( defined( 'T_ABSTRACT' ) && $tokens[ $prev ][0] === T_ABSTRACT ) ) ) {
						$prev--;
					}
					if ( $prev >= 0 && is_array( $tokens[ $prev ] ) && in_array( $tokens[ $prev ][0], array( T_PUBLIC, T_PROTECTED, T_PRIVATE ), true ) ) {
						$is_method = true;
					}

					if ( ! $is_method ) {
						$next = $i + 1;
						while ( $next < $count && is_array( $tokens[ $next ] ) && $tokens[ $next ][0] === T_WHITESPACE ) {
							$next++;
						}
						if ( $next < $count && is_array( $tokens[ $next ] ) && $tokens[ $next ][0] === T_STRING ) {
							$func_name = $tokens[ $next ][1];
							if ( strpos( $func_name, 'wpdev_' ) === 0 || strpos( $func_name, '_wpdev_' ) === 0 || strpos( $func_name, 'tavangary_' ) === 0 ) {
								continue;
							}
							if ( in_array( strtolower( $func_name ), array_map( 'strtolower', self::$reserved_funcs ), true ) ) {
								continue;
							}
							$fqfn = ! empty( $current_namespace ) ? ( $current_namespace . '\\' . $func_name ) : $func_name;
							$this->function_declarations[] = array(
								'fqfn'      => $fqfn,
								'namespace' => $current_namespace,
								'name'      => $func_name,
								'file'      => $file_path,
							);
							$mangled = '_f_' . substr( hash( 'sha256', $this->seed . ':func:' . strtolower( $fqfn ) ), 0, 8 );

							if ( $this->flatten_namespaces ) {
								$this->record_short_function_name( $func_name, $mangled );
								if ( ! empty( $current_namespace ) ) {
									$this->function_map[ $fqfn ] = $mangled;
									$this->function_map[ '\\' . $fqfn ] = '\\' . $mangled;
									$this->scoped_function_map[ $current_namespace ][ strtolower( $func_name ) ] = $mangled;
								} else {
									$this->global_function_map[ strtolower( $func_name ) ] = $mangled;
								}
							} else {
								if ( ! empty( $current_namespace ) ) {
									$this->function_map[ $fqfn ] = $current_namespace . '\\' . $mangled;
									$this->function_map[ '\\' . $fqfn ] = '\\' . $current_namespace . '\\' . $mangled;
									$this->scoped_function_map[ $current_namespace ][ strtolower( $func_name ) ] = $mangled;
								} else {
									$this->function_map[ $func_name ] = $mangled;
									$this->function_map[ '\\' . $func_name ] = '\\' . $mangled;
									$this->global_function_map[ strtolower( $func_name ) ] = $mangled;
								}
							}
						}
					}
				}
			}
		}
	}

	public function transform( $source, $is_main_plugin_file = false, $file_rel_path = '' ) {
		$tokens = token_get_all( $source );
		$count  = count( $tokens );

		$private_methods    = array();
		$private_properties = array();
		$private_constants  = array();
		$public_properties  = array();
		$renamed_symbols           = array();
		$declared_functions_in_file = array();
		$current_namespace         = '';
		$is_view_file       = ( strpos( str_replace( '\\', '/', (string) $file_rel_path ), 'views/' ) !== false || strpos( str_replace( '\\', '/', (string) $file_rel_path ), 'templates/' ) !== false );

		$preserved_vars   = array();
		$dynamic_scopes   = array();
		$token_scopes     = array();
		$scope_stack      = array( 0 );
		$current_scope_id = 0;
		$next_scope_id    = 1;
		$pending_scope_id = null;

		// Pass 1: Discover strictly private methods, properties, and constants in this file,
		// and track scopes with dynamic variable introspection.
		for ( $i = 0; $i < $count; $i++ ) {
			$token = $tokens[ $i ];
			if ( is_string( $token ) ) {
				if ( $token === '{' ) {
					if ( $pending_scope_id !== null ) {
						array_push( $scope_stack, $pending_scope_id );
						$current_scope_id = $pending_scope_id;
						$pending_scope_id = null;
					} else {
						array_push( $scope_stack, $current_scope_id );
					}
				} elseif ( $token === '}' ) {
					if ( count( $scope_stack ) > 1 ) {
						array_pop( $scope_stack );
						$current_scope_id = end( $scope_stack );
					}
				} elseif ( $token === ';' && $pending_scope_id !== null ) {
					$pending_scope_id = null;
				}
				$token_scopes[ $i ] = ( $pending_scope_id !== null ) ? $pending_scope_id : $current_scope_id;
				continue;
			}

			$id = $token[0];
			$token_scopes[ $i ] = ( $pending_scope_id !== null ) ? $pending_scope_id : $current_scope_id;

			if ( $id === T_FUNCTION || ( defined( 'T_FN' ) && $id === T_FN ) ) {
				$pending_scope_id = $next_scope_id++;
			} elseif ( $id === T_GLOBAL ) {
				$k = $i + 1;
				while ( $k < $count && ( ! is_string( $tokens[ $k ] ) || $tokens[ $k ] !== ';' ) ) {
					if ( is_array( $tokens[ $k ] ) && $tokens[ $k ][0] === T_VARIABLE ) {
						$preserved_vars[ $tokens[ $k ][1] ] = true;
					}
					$k++;
				}
			} elseif ( $id === T_STRING && strtolower( $token[1] ) === 'extract' ) {
				$p = $this->prev_code_index( $tokens, $i );
				$is_method = ( $p >= 0 && is_array( $tokens[ $p ] ) && in_array( $tokens[ $p ][0], array( T_OBJECT_OPERATOR, defined( 'T_NULLSAFE_OBJECT_OPERATOR' ) ? T_NULLSAFE_OBJECT_OPERATOR : -1, T_DOUBLE_COLON ), true ) );
				if ( ! $is_method ) {
					$dynamic_scopes[ $current_scope_id ] = true;
				}
			} elseif ( $id === T_STRING && strtolower( $token[1] ) === 'compact' ) {
				$p = $this->prev_code_index( $tokens, $i );
				$is_method = ( $p >= 0 && is_array( $tokens[ $p ] ) && in_array( $tokens[ $p ][0], array( T_OBJECT_OPERATOR, defined( 'T_NULLSAFE_OBJECT_OPERATOR' ) ? T_NULLSAFE_OBJECT_OPERATOR : -1, T_DOUBLE_COLON ), true ) );
				if ( ! $is_method ) {
					$compact_check = $this->try_rewrite_compact_call( $tokens, $i, $count );
					if ( $compact_check === null ) {
						$dynamic_scopes[ $current_scope_id ] = true;
					}
				}
			} elseif ( $id === T_VARIABLE && $token[1] === '$GLOBALS' ) {
				$dynamic_scopes[ $current_scope_id ] = true;
			} elseif ( $id === T_VARIABLE ) {
				$p = $this->prev_code_index( $tokens, $i );
				if ( $p >= 0 && is_string( $tokens[ $p ] ) && $tokens[ $p ] === '$' ) {
					$dynamic_scopes[ $current_scope_id ] = true;
				}
			} elseif ( defined( 'T_DOLLAR_OPEN_CURLY_BRACES' ) && $id === T_DOLLAR_OPEN_CURLY_BRACES ) {
				$dynamic_scopes[ $current_scope_id ] = true;
			}

			if ( $id === T_NAMESPACE ) {
				$prev = $i - 1;
				while ( $prev >= 0 && is_array( $tokens[ $prev ] ) && $tokens[ $prev ][0] === T_WHITESPACE ) {
					$prev--;
				}
				$is_double_colon = ( $prev >= 0 && is_array( $tokens[ $prev ] ) && $tokens[ $prev ][0] === T_DOUBLE_COLON );

				if ( ! $is_double_colon ) {
					$spec = $this->read_namespace_spec( $tokens, $i, $count );
					$current_namespace = $spec['name'];
				}
			} elseif ( $id === T_PRIVATE ) {
				$j = $i + 1;
				$is_function = false;
				$is_const    = false;
				$func_name   = '';
				$prop_names  = array();
				$const_names = array();

				while ( $j < $count && ( ! is_string( $tokens[ $j ] ) || ( $tokens[ $j ] !== ';' && $tokens[ $j ] !== '{' ) ) ) {
					if ( is_array( $tokens[ $j ] ) ) {
						if ( $tokens[ $j ][0] === T_FUNCTION ) {
							$is_function = true;
							$k = $j + 1;
							while ( $k < $count && is_array( $tokens[ $k ] ) && $tokens[ $k ][0] === T_WHITESPACE ) {
								$k++;
							}
							if ( $k < $count && is_array( $tokens[ $k ] ) && $tokens[ $k ][0] === T_STRING ) {
								$func_name = $tokens[ $k ][1];
							}
							break;
						} elseif ( $tokens[ $j ][0] === T_CONST ) {
							$is_const = true;
							$k = $j + 1;
							$in_val = false;
							$bracket_depth = 0;

							while ( $k < $count && ( ! is_string( $tokens[ $k ] ) || ( $tokens[ $k ] !== ';' && $tokens[ $k ] !== '{' ) || $bracket_depth > 0 ) ) {
								$tk = $tokens[ $k ];
								if ( is_string( $tk ) ) {
									if ( $tk === '[' || $tk === '(' ) {
										$bracket_depth++;
									} elseif ( $tk === ']' || $tk === ')' ) {
										$bracket_depth--;
									} elseif ( $tk === '=' && $bracket_depth === 0 ) {
										$in_val = true;
									} elseif ( $tk === ',' && $bracket_depth === 0 ) {
										$in_val = false;
									} elseif ( $tk === ';' && $bracket_depth === 0 ) {
										break;
									}
								} elseif ( is_array( $tk ) ) {
									if ( ! $in_val && $bracket_depth === 0 && $tk[0] === T_STRING ) {
										$const_names[] = $tk[1];
									}
								}
								$k++;
							}
							break;
						} elseif ( $tokens[ $j ][0] === T_VARIABLE ) {
							$prop_names[] = substr( $tokens[ $j ][1], 1 );
						}
					}
					$j++;
				}

				if ( $is_function && ! empty( $func_name ) ) {
					if ( ! in_array( $func_name, self::$magic_methods, true ) ) {
						$mangled = '_m_' . substr( hash( 'sha256', $this->seed . ':m:' . $func_name ), 0, 8 );
						$private_methods[ $func_name ] = $mangled;
						$renamed_symbols[] = array( 'type' => 'private_method', 'original' => $func_name, 'mangled' => $mangled );
					}
				} elseif ( $is_const && ! empty( $const_names ) ) {
					foreach ( $const_names as $c_name ) {
						$mangled = '_k_' . substr( hash( 'sha256', $this->seed . ':k:' . $c_name ), 0, 8 );
						$private_constants[ $c_name ] = $mangled;
						$renamed_symbols[] = array( 'type' => 'private_constant', 'original' => $c_name, 'mangled' => $mangled );
					}
				} elseif ( ! empty( $prop_names ) ) {
					foreach ( $prop_names as $prop_name ) {
						$mangled = '_p_' . substr( hash( 'sha256', $this->seed . ':p:' . $prop_name ), 0, 8 );
						$private_properties[ $prop_name ] = $mangled;
						$renamed_symbols[] = array( 'type' => 'private_property', 'original' => $prop_name, 'mangled' => $mangled );
					}
				}
			} elseif ( $id === T_PUBLIC || $id === T_PROTECTED || $id === T_VAR || $id === T_STATIC ) {
				$j = $i + 1;
				$is_function = false;
				$prop_names = array();

				while ( $j < $count && ( ! is_string( $tokens[ $j ] ) || ( $tokens[ $j ] !== ';' && $tokens[ $j ] !== '{' ) ) ) {
					if ( is_array( $tokens[ $j ] ) ) {
						if ( $tokens[ $j ][0] === T_FUNCTION ) {
							$is_function = true;
							break;
						} elseif ( $tokens[ $j ][0] === T_VARIABLE ) {
							$prop_names[] = substr( $tokens[ $j ][1], 1 );
						}
					}
					$j++;
				}

				if ( ! $is_function && ! empty( $prop_names ) ) {
					foreach ( $prop_names as $prop_name ) {
						$public_properties[ $prop_name ] = true;
					}
				}
			}
		}

		$file_use_map = array();
		$file_use_func_map = array();
		for ( $i = 0; $i < $count; $i++ ) {
			$token = $tokens[ $i ];
			if ( is_array( $token ) && $token[0] === T_USE ) {
				$prev = $i - 1;
				while ( $prev >= 0 && is_array( $tokens[ $prev ] ) && $tokens[ $prev ][0] === T_WHITESPACE ) {
					$prev--;
				}
				$is_closure_use = ( $prev >= 0 && is_string( $tokens[ $prev ] ) && $tokens[ $prev ] === ')' );
				if ( ! $is_closure_use ) {
					$j = $i + 1;
					$use_str = '';
					while ( $j < $count && ( ! is_string( $tokens[ $j ] ) || $tokens[ $j ] !== ';' ) ) {
						if ( is_array( $tokens[ $j ] ) ) {
							$use_str .= $tokens[ $j ][1];
						} else {
							$use_str .= $tokens[ $j ];
						}
						$j++;
					}
					$clauses = explode( ',', $use_str );
					foreach ( $clauses as $clause ) {
						$clause = trim( $clause );
						if ( preg_match( '/^function\s+\\\\?([a-zA-Z0-9_\\\\]+)(?:\\s+as\\s+([a-zA-Z0-9_]+))?$/i', $clause, $m ) ) {
							$fqfn = ltrim( $m[1], '\\' );
							$short_alias = isset( $m[2] ) && ! empty( $m[2] ) ? $m[2] : substr( strrchr( '\\' . $fqfn, '\\' ), 1 );
							$file_use_func_map[ strtolower( $short_alias ) ] = $fqfn;
						} elseif ( preg_match( '/^\\\\?([a-zA-Z0-9_\\\\]+)(?:\\s+as\\s+([a-zA-Z0-9_]+))?$/i', $clause, $m ) ) {
							$fqcn = ltrim( $m[1], '\\' );
							$short_alias = isset( $m[2] ) && ! empty( $m[2] ) ? $m[2] : substr( strrchr( '\\' . $fqcn, '\\' ), 1 );
							$file_use_map[ $short_alias ] = $fqcn;
						}
					}
				}
			}
		}

		$has_frozen_public_class = false;
		for ( $i = 0; $i < $count; $i++ ) {
			$token = $tokens[ $i ];
			if ( is_array( $token ) && ( $token[0] === T_CLASS || $token[0] === T_INTERFACE || $token[0] === T_TRAIT ) ) {
				$next = $i + 1;
				while ( $next < $count && is_array( $tokens[ $next ] ) && ( $tokens[ $next ][0] === T_WHITESPACE || $tokens[ $next ][0] === T_STATIC || $tokens[ $next ][0] === T_ABSTRACT || $tokens[ $next ][0] === T_FINAL ) ) {
					$next++;
				}
				if ( $next < $count && is_array( $tokens[ $next ] ) && in_array( $tokens[ $next ][1], self::$frozen_public_classes, true ) ) {
					$has_frozen_public_class = true;
					break;
				}
			}
		}

		// Pass 2: Reconstruct code
		$output                 = '';
		$in_double_quote_string = false;
		$seen_first_docblock    = false;
		$current_namespace      = '';
		$in_class               = false;
		$class_brace_depth      = 0;
		$declared_classes_in_file = array();
		$pending_ns_brace       = false;
		$ns_brace_depth         = 0;

		for ( $i = 0; $i < $count; $i++ ) {
			$token = $tokens[ $i ];

			if ( is_string( $token ) ) {
				if ( $token === '{' ) {
					if ( $pending_ns_brace ) {
						$pending_ns_brace = false;
						$ns_brace_depth   = 1;
						if ( $this->flatten_namespaces && ! $has_frozen_public_class ) {
							continue;
						}
					} else {
						if ( $in_class ) {
							$class_brace_depth++;
						}
						if ( $ns_brace_depth > 0 ) {
							$ns_brace_depth++;
						}
					}
				} elseif ( $token === '}' ) {
					$closing_ns = false;
					if ( $ns_brace_depth > 0 ) {
						$ns_brace_depth--;
						if ( $ns_brace_depth === 0 ) {
							$closing_ns          = true;
							$current_namespace   = '';
						}
					}
					if ( $in_class ) {
						$class_brace_depth--;
						if ( $class_brace_depth <= 0 ) {
							$in_class          = false;
							$class_brace_depth = 0;
						}
					}
					if ( $closing_ns && $this->flatten_namespaces && ! $has_frozen_public_class ) {
						continue;
					}
				}
			}

			if ( is_array( $token ) ) {
				$id   = $token[0];
				$text = $token[1];

				if ( $id === T_CLASS || $id === T_INTERFACE || $id === T_TRAIT || ( defined( 'T_ENUM' ) && $id === T_ENUM ) ) {
					$in_class = true;
				}

				// 0. Namespace Declaration Protection and Tracking
				if ( $id === T_NAMESPACE ) {
					$prev = $i - 1;
					while ( $prev >= 0 && is_array( $tokens[ $prev ] ) && $tokens[ $prev ][0] === T_WHITESPACE ) {
						$prev--;
					}
					$is_double_colon = ( $prev >= 0 && is_array( $tokens[ $prev ] ) && $tokens[ $prev ][0] === T_DOUBLE_COLON );

					if ( ! $is_double_colon ) {
						$spec = $this->read_namespace_spec( $tokens, $i, $count );
						$current_namespace = $spec['name'];
						$pending_ns_brace = ( $spec['terminator'] === '{' );
						if ( ! $this->flatten_namespaces || $has_frozen_public_class ) {
							$output .= 'namespace ' . $current_namespace;
							if ( $spec['terminator'] === ';' ) {
								$output .= ';';
							}
						}
						$i = $spec['end'];
						if ( $spec['terminator'] === ';' ) {
							continue;
						}
						$i = $spec['end'] - 1;
						continue;
					} else {
						$output .= $text;
						continue;
					}
				}

				// 1. Class Constant Declaration Mangling
				if ( $id === T_CONST ) {
					$output .= $text;
					$j = $i + 1;
					$in_value = false;
					$bracket_depth = 0;

					while ( $j < $count && ( ! is_string( $tokens[ $j ] ) || ( $tokens[ $j ] !== ';' && $tokens[ $j ] !== '{' ) || $bracket_depth > 0 ) ) {
						$t = $tokens[ $j ];
						if ( is_string( $t ) ) {
							if ( $t === '[' || $t === '(' ) {
								$bracket_depth++;
							} elseif ( $t === ']' || $t === ')' ) {
								$bracket_depth--;
							} elseif ( $t === '=' && $bracket_depth === 0 ) {
								$in_value = true;
							} elseif ( $t === ',' && $bracket_depth === 0 ) {
								$in_value = false;
							} elseif ( $t === ';' && $bracket_depth === 0 ) {
								$output .= ';';
								$j++;
								break;
							}
							$output .= $t;
						} elseif ( is_array( $t ) ) {
							if ( ! $in_value && $bracket_depth === 0 && $t[0] === T_STRING && isset( $private_constants[ $t[1] ] ) ) {
								$output .= $private_constants[ $t[1] ];
							} elseif ( $in_value && ( $t[0] === T_STRING || ( defined( 'T_NAME_QUALIFIED' ) && $t[0] === T_NAME_QUALIFIED ) ) ) {
								if ( isset( $file_use_map[ $t[1] ] ) && isset( $this->class_map[ $file_use_map[ $t[1] ] ] ) ) {
									$target = $this->class_map[ $file_use_map[ $t[1] ] ];
									$output .= ( $this->flatten_namespaces && ! empty( $current_namespace ) ) ? ( '\\' . $target ) : $target;
								} elseif ( ! empty( $current_namespace ) && isset( $this->class_map[ $current_namespace . '\\' . $t[1] ] ) ) {
									$target = $this->class_map[ $current_namespace . '\\' . $t[1] ];
									if ( ! $this->flatten_namespaces && strncmp( $target, $current_namespace . '\\', strlen( $current_namespace ) + 1 ) === 0 ) {
										$output .= substr( $target, strlen( $current_namespace ) + 1 );
									} else {
										$output .= ( $this->flatten_namespaces && ! empty( $current_namespace ) ) ? ( '\\' . $target ) : $target;
									}
								} elseif ( isset( $this->class_map[ $t[1] ] ) ) {
									$target = $this->class_map[ $t[1] ];
									$output .= ( $this->flatten_namespaces && ! empty( $current_namespace ) ) ? ( '\\' . $target ) : $target;
								} else {
									$output .= $t[1];
								}
							} else {
								$output .= ( $t[0] === T_WHITESPACE ) ? ' ' : $t[1];
							}
						}
						$j++;
					}
					$i = $j - 1;
					continue;
				}

				
				// 1b. Use Statement Mangling (Top-level vs Trait use inside class vs Closure use)
				if ( $id === T_USE ) {
					$prev = $i - 1;
					while ( $prev >= 0 && is_array( $tokens[ $prev ] ) && $tokens[ $prev ][0] === T_WHITESPACE ) {
						$prev--;
					}
					$is_closure_use = ( $prev >= 0 && is_string( $tokens[ $prev ] ) && $tokens[ $prev ] === ')' );
					
					if ( ! $is_closure_use ) {
						$is_trait_use = ( $in_class && $class_brace_depth >= 1 );

						if ( $is_trait_use ) {
							// Trait use statement inside class body: preserve and mangle trait name
							$output .= 'use ';
							$j = $i + 1;
							while ( $j < $count && ( ! is_string( $tokens[ $j ] ) || $tokens[ $j ] !== ';' ) ) {
								$t = $tokens[ $j ];
								if ( is_array( $t ) ) {
									if ( $t[0] === T_STRING || ( defined( 'T_NAME_QUALIFIED' ) && $t[0] === T_NAME_QUALIFIED ) || ( defined( 'T_NAME_FULLY_QUALIFIED' ) && $t[0] === T_NAME_FULLY_QUALIFIED ) ) {
										$raw_t = ltrim( $t[1], '\\' );
										if ( isset( $this->class_map[ $raw_t ] ) ) {
											$output .= $this->class_map[ $raw_t ];
										} elseif ( ! empty( $current_namespace ) && isset( $this->class_map[ $current_namespace . '\\' . $raw_t ] ) ) {
											$output .= $this->class_map[ $current_namespace . '\\' . $raw_t ];
										} else {
											$output .= $t[1];
										}
									} else {
										$output .= ( $t[0] === T_WHITESPACE ) ? ' ' : $t[1];
									}
								} else {
									$output .= $t;
								}
								$j++;
							}
							if ( $j < $count && is_string( $tokens[ $j ] ) && $tokens[ $j ] === ';' ) {
								$output .= ";\n";
								$j++;
							}
							$i = $j - 1;
							continue;
						}

						// Top-level namespace use statement
						$j = $i + 1;
						$use_statement_tokens = array();
						while ( $j < $count && ( ! is_string( $tokens[ $j ] ) || $tokens[ $j ] !== ';' ) ) {
							$use_statement_tokens[] = $tokens[ $j ];
							$j++;
						}
						if ( $j < $count && is_string( $tokens[ $j ] ) && $tokens[ $j ] === ';' ) {
							$j++;
						}
						
						$clauses = array();
						$current_clause = array();
						foreach ( $use_statement_tokens as $t ) {
							if ( is_string( $t ) && $t === ',' ) {
								$clauses[] = $current_clause;
								$current_clause = array();
							} else {
								$current_clause[] = $t;
							}
						}
						if ( ! empty( $current_clause ) ) {
							$clauses[] = $current_clause;
						}

						if ( $this->flatten_namespaces ) {
							$preserved_clauses = array();
							foreach ( $clauses as $clause ) {
								$target_class = '';
								foreach ( $clause as $ct ) {
									if ( is_array( $ct ) && $ct[0] !== T_WHITESPACE && $ct[0] !== T_AS ) {
										$target_class .= $ct[1];
									} elseif ( is_string( $ct ) ) {
										$target_class .= $ct;
									}
								}
								$target_class = trim( $target_class, "\\ " );
								// Keep compound external use statements (having '\' and not in class_map)
								if ( ! isset( $this->class_map[ $target_class ] ) && ! isset( $this->class_map[ '\\' . $target_class ] ) && strpos( $target_class, '\\' ) !== false ) {
									$raw = '';
									foreach ( $clause as $ct ) {
										$raw .= is_array( $ct ) ? ( ( $ct[0] === T_WHITESPACE ) ? ' ' : $ct[1] ) : $ct;
									}
									$preserved_clauses[] = trim( $raw );
								}
							}
							if ( ! empty( $preserved_clauses ) ) {
								$output .= 'use ' . implode( ', ', $preserved_clauses ) . ";\n";
							}
							$i = $j - 1;
							continue;
						}

						$rendered_clauses = array();
						foreach ( $clauses as $clause ) {
							$has_as = false;
							$as_alias = '';
							$target_class = '';
							
							$c_count = count( $clause );
							for ( $ci = 0; $ci < $c_count; $ci++ ) {
								$ct = $clause[ $ci ];
								if ( is_array( $ct ) && $ct[0] === T_AS ) {
									$has_as = true;
									for ( $cj = $ci + 1; $cj < $c_count; $cj++ ) {
										if ( is_array( $clause[ $cj ] ) && $clause[ $cj ][0] === T_STRING ) {
											$as_alias = $clause[ $cj ][1];
											break;
										}
									}
									break;
								}
								if ( is_array( $ct ) ) {
									if ( $ct[0] !== T_WHITESPACE ) {
										$target_class .= $ct[1];
									}
								} elseif ( is_string( $ct ) ) {
									$target_class .= $ct;
								}
							}
							
							$target_class = trim( $target_class, "\\ " );
							
							if ( isset( $this->class_map[ $target_class ] ) ) {
								$mangled_target = $this->class_map[ $target_class ];
								$parts = explode( '\\', $target_class );
								$short_name = end( $parts );
								
								if ( $has_as ) {
									$rendered_clauses[] = $mangled_target . ' as ' . $as_alias;
								} else {
									$rendered_clauses[] = $mangled_target . ' as ' . $short_name;
								}
							} else {
								$rendered_clause = '';
								foreach ( $clause as $ct ) {
									if ( is_array( $ct ) ) {
										$rendered_clause .= ( $ct[0] === T_WHITESPACE ) ? ' ' : $ct[1];
									} else {
										$rendered_clause .= $ct;
									}
								}
								$rendered_clauses[] = trim( $rendered_clause );
							}
						}
						
						$output .= 'use ' . implode( ', ', $rendered_clauses ) . ";\n";
						$i = $j - 1;
						continue;
					}
				}

				// 1b. Inline HTML comment stripping
				if ( $id === T_INLINE_HTML ) {
					$output .= preg_replace( '/\/\*[\s\S]*?\*\//', '', $text );
					continue;
				}

				// 2. Comment Stripping
				if ( $id === T_COMMENT || $id === T_DOC_COMMENT ) {
					if ( $is_main_plugin_file && ! $seen_first_docblock && stripos( $text, 'Plugin Name:' ) !== false ) {
						$seen_first_docblock = true;
						$output .= "\n" . $text . "\n";
					}
					continue;
				}

				// 3. Whitespace Compaction
				if ( $id === T_WHITESPACE ) {
					if ( strpos( $text, "\n" ) !== false ) {
						$output .= "\n";
					} else {
						$output .= ' ';
					}
					continue;
				}

				// 4. Qualified Class / Function Name Mangling (e.g. TavangaryTheme\ThemeOptions\Sections\Register, Admin\UserPurchaseFilterPage)
				if ( defined( 'T_NAME_FULLY_QUALIFIED' ) && $id === T_NAME_FULLY_QUALIFIED ) {
					$clean = ltrim( $text, '\\' );
					if ( isset( $this->class_map[ $clean ] ) ) {
						$output .= '\\' . $this->class_map[ $clean ];
						continue;
					}
					$func_target = $this->resolve_function_name( $clean, '', $file_use_func_map );
					if ( $func_target !== null ) {
						$output .= ( $this->flatten_namespaces ? '' : '\\' ) . $func_target;
						continue;
					}
				}
				if ( defined( 'T_NAME_QUALIFIED' ) && $id === T_NAME_QUALIFIED ) {
					$parts = explode( '\\', $text );
					$first_part = $parts[0];
					$resolved_fqcn = null;
					if ( isset( $file_use_map[ $first_part ] ) ) {
						$resolved_fqcn = $file_use_map[ $first_part ] . '\\' . implode( '\\', array_slice( $parts, 1 ) );
					} elseif ( ! empty( $current_namespace ) ) {
						$resolved_fqcn = $current_namespace . '\\' . $text;
					} else {
						$resolved_fqcn = $text;
					}

					if ( isset( $this->class_map[ $resolved_fqcn ] ) ) {
						$target = $this->class_map[ $resolved_fqcn ];
						$output .= ( $this->flatten_namespaces && ! empty( $current_namespace ) ) ? ( '\\' . $target ) : $target;
						continue;
					}
					if ( isset( $this->class_map[ $text ] ) ) {
						$target = $this->class_map[ $text ];
						$output .= ( $this->flatten_namespaces && ! empty( $current_namespace ) ) ? ( '\\' . $target ) : $target;
						continue;
					}
					if ( ! empty( $current_namespace ) && isset( $this->class_map[ $current_namespace . '\\' . $text ] ) ) {
						$target = $this->class_map[ $current_namespace . '\\' . $text ];
						if ( $this->flatten_namespaces ) {
							$output .= '\\' . $target;
						} else {
							if ( strncmp( $target, $current_namespace . '\\', strlen( $current_namespace ) + 1 ) === 0 ) {
								$output .= substr( $target, strlen( $current_namespace ) + 1 );
							} else {
								$output .= '\\' . $target;
							}
						}
						continue;
					}

					$func_target = $this->resolve_function_name( $text, $current_namespace, $file_use_func_map );
					if ( $func_target !== null ) {
						$output .= ( $this->flatten_namespaces ? '' : ( ! empty( $current_namespace ) ? '' : '\\' ) ) . $func_target;
						continue;
					}
				}

				// 5. Standalone Class / Function Name Mangling
				if ( $id === T_STRING ) {
					if ( strtolower( $text ) === 'compact' ) {
						$compact = $this->try_rewrite_compact_call( $tokens, $i, $count );
						if ( $compact !== null ) {
							$output .= $compact['code'];
							$i = $compact['end'];
							continue;
						}
					}

					$prev = $i - 1;
					while ( $prev >= 0 && is_array( $tokens[ $prev ] ) && ( $tokens[ $prev ][0] === T_WHITESPACE || $tokens[ $prev ][0] === T_STATIC || $tokens[ $prev ][0] === T_ABSTRACT || $tokens[ $prev ][0] === T_FINAL ) ) {
						$prev--;
					}
					$decl_type = ( $prev >= 0 && is_array( $tokens[ $prev ] ) ) ? $tokens[ $prev ][0] : null;
					$declaration_tokens = array( T_CLASS, T_INTERFACE, T_TRAIT, T_FUNCTION );
					if ( defined( 'T_ENUM' ) ) {
						$declaration_tokens[] = T_ENUM;
					}
					$is_declaration = ( $decl_type && in_array( $decl_type, $declaration_tokens, true ) );
					$is_method_declaration = ( $decl_type === T_FUNCTION && $in_class );

					if ( $is_method_declaration ) {
						// Public/protected method names must keep their contract.
						// Private method declarations are rewritten in section 10.
					} else {
						if ( $decl_type === T_FUNCTION && ! $is_method_declaration ) {
							$func_target = $this->resolve_function_name( $text, $current_namespace, $file_use_func_map );
							if ( $func_target !== null ) {
								$fqfn = ! empty( $current_namespace ) ? ( $current_namespace . '\\' . $text ) : $text;
								$declared_functions_in_file[] = array(
									'fqfn'      => $fqfn,
									'namespace' => $current_namespace,
									'name'      => $text,
									'mangled'   => $func_target,
								);
								$output .= $func_target;
								continue;
							}
						}
						if ( ! $is_declaration && isset( $file_use_map[ $text ] ) ) {
							if ( isset( $this->class_map[ $file_use_map[ $text ] ] ) ) {
								$target = $this->class_map[ $file_use_map[ $text ] ];
								$output .= ( $this->flatten_namespaces && ! empty( $current_namespace ) ) ? ( '\\' . $target ) : $target;
								continue;
							} else {
								$output .= '\\' . $file_use_map[ $text ];
								continue;
							}
						}
						if ( ! empty( $current_namespace ) && isset( $this->class_map[ $current_namespace . '\\' . $text ] ) ) {
							$target = $this->class_map[ $current_namespace . '\\' . $text ];
							if ( $decl_type === T_CLASS || $decl_type === T_INTERFACE || $decl_type === T_TRAIT || ( defined( 'T_ENUM' ) && $decl_type === T_ENUM ) ) {
								$declared_classes_in_file[ $current_namespace . '\\' . $text ] = array(
									'mangled' => $target,
									'type'    => $decl_type,
								);
							}
							if ( $this->flatten_namespaces ) {
								$output .= ( $is_declaration || empty( $current_namespace ) ) ? $target : ( '\\' . $target );
							} else {
								if ( strncmp( $target, $current_namespace . '\\', strlen( $current_namespace ) + 1 ) === 0 ) {
									$output .= substr( $target, strlen( $current_namespace ) + 1 );
								} else {
									$output .= $target;
								}
							}
							continue;
						}
						if ( ! $is_declaration && ! empty( $current_namespace ) && in_array( $text, self::$frozen_public_classes, true ) ) {
							$output .= '\\' . $current_namespace . '\\' . $text;
							continue;
						}
						if ( isset( $this->class_map[ $text ] ) ) {
							$target = $this->class_map[ $text ];
							$output .= ( $this->flatten_namespaces && ! empty( $current_namespace ) && ! $is_declaration ) ? ( '\\' . $target ) : $target;
							continue;
						}

						$p = $this->prev_code_index( $tokens, $i );
						$is_prop_or_method = ( $p >= 0 && is_array( $tokens[ $p ] ) && in_array( $tokens[ $p ][0], array( T_OBJECT_OPERATOR, defined( 'T_NULLSAFE_OBJECT_OPERATOR' ) ? T_NULLSAFE_OBJECT_OPERATOR : -1, T_DOUBLE_COLON ), true ) );
						if ( ! $is_declaration && ! $is_prop_or_method ) {
							$func_target = $this->resolve_function_name( $text, $current_namespace, $file_use_func_map );
							if ( $func_target !== null ) {
								$output .= $func_target;
								continue;
							}
						}
					}
				}

				// 6. String Literals
				if ( $id === T_CONSTANT_ENCAPSED_STRING ) {
					$raw_str = trim( $text, "'\"" );
					$norm_str = ltrim( str_replace( '\\\\', '\\', $raw_str ), '\\' );

					if ( $this->is_gettext_string( $tokens, $i ) ||
					     $this->is_array_key_string( $tokens, $i, $count ) ||
					     $this->is_array_subscript_string( $tokens, $i ) ||
					     $this->is_hook_name_string( $tokens, $i ) ) {
						$output .= $text;
						continue;
					}

					$is_callback_string = $this->is_array_callable_method_string( $tokens, $i ) || $this->is_callback_key_string( $tokens, $i ) || $this->is_callback_argument_string( $tokens, $i );
					$is_reflection = $this->is_reflection_or_instantiation_string( $tokens, $i );

					if ( isset( $this->class_map[ $norm_str ] ) && ( strpos( $norm_str, '\\' ) !== false || $is_reflection || $this->is_array_callable_method_string( $tokens, $i ) ) ) {
						$quote = $text[0];
						$target = $this->class_map[ $norm_str ];
						if ( ! $this->flatten_namespaces && substr( $raw_str, 0, 1 ) === '\\' ) {
							$target = '\\' . $target;
						}
						if ( $quote === '"' || strpos( $text, '\\\\' ) !== false ) {
							$target = str_replace( '\\', '\\\\', $target );
						}
						$output .= $quote . $target . $quote;
						continue;
					}

					if ( $is_callback_string ) {
						$func_target = $this->resolve_function_name( $norm_str, $current_namespace, $file_use_func_map );
						if ( $func_target !== null ) {
							$quote = $text[0];
							$output .= $quote . $func_target . $quote;
							continue;
						}
					}

					if ( isset( $private_methods[ $raw_str ] ) && $is_callback_string ) {
						$quote = $text[0];
						$output .= $quote . $private_methods[ $raw_str ] . $quote;
						continue;
					}
					if ( isset( $private_constants[ $raw_str ] ) ) {
						$quote = $text[0];
						$output .= $quote . $private_constants[ $raw_str ] . $quote;
						continue;
					}

					$output .= $text;
					continue;
				}

				// 7. Variable Mangling
				if ( $id === T_VARIABLE ) {
					$scope_id = isset( $token_scopes[ $i ] ) ? $token_scopes[ $i ] : 0;
					$is_dynamic = ! empty( $dynamic_scopes[ $scope_id ] ) || ! empty( $dynamic_scopes[0] );
					if ( in_array( $text, self::$reserved_vars, true ) || isset( $preserved_vars[ $text ] ) || $is_view_file || $is_dynamic ) {
						$output .= $text;
					} else {
						$raw_name = substr( $text, 1 );
						if ( isset( $private_properties[ $raw_name ] ) ) {
							$output .= '$' . $private_properties[ $raw_name ];
						} elseif ( isset( $public_properties[ $raw_name ] ) ) {
							$output .= $text;
						} else {
							$output .= '$_v_' . substr( hash( 'sha256', $this->seed . ':v:' . $text ), 0, 8 );
						}
					}
					continue;
				}

				// 8. Object Property & Method Access ($this->prop, $this->method(), $this?->method())
				if ( $id === T_OBJECT_OPERATOR || ( defined( 'T_NULLSAFE_OBJECT_OPERATOR' ) && $id === T_NULLSAFE_OBJECT_OPERATOR ) ) {
					$prev = $i - 1;
					while ( $prev >= 0 && is_array( $tokens[ $prev ] ) && $tokens[ $prev ][0] === T_WHITESPACE ) {
						$prev--;
					}
					$is_this = ( $prev >= 0 && is_array( $tokens[ $prev ] ) && $tokens[ $prev ][0] === T_VARIABLE && $tokens[ $prev ][1] === '$this' );

					$output .= $text;
					$next = $i + 1;
					$ws = '';
					while ( $next < $count && is_array( $tokens[ $next ] ) && $tokens[ $next ][0] === T_WHITESPACE ) {
						$ws .= $tokens[ $next ][1];
						$next++;
					}
					if ( $next < $count && is_array( $tokens[ $next ] ) && $tokens[ $next ][0] === T_STRING ) {
						$accessed_name = $tokens[ $next ][1];
						$after_next = $next + 1;
						while ( $after_next < $count && is_array( $tokens[ $after_next ] ) && $tokens[ $after_next ][0] === T_WHITESPACE ) {
							$after_next++;
						}
						$is_method_call = ( $after_next < $count && is_string( $tokens[ $after_next ] ) && $tokens[ $after_next ] === '(' );

						if ( $is_this && $is_method_call && isset( $private_methods[ $accessed_name ] ) ) {
							$output .= $ws . $private_methods[ $accessed_name ];
							$i = $next;
							continue;
						} elseif ( ! $is_method_call && isset( $private_properties[ $accessed_name ] ) ) {
							$output .= $ws . $private_properties[ $accessed_name ];
							$i = $next;
							continue;
						}
					}
					$output .= $ws;
					$i = $next - 1;
					continue;
				}

				// 9. Static Method & Static Property Access (self::method(), self::$prop, self::CONST)
				if ( $id === T_DOUBLE_COLON ) {
					$prev = $i - 1;
					while ( $prev >= 0 && is_array( $tokens[ $prev ] ) && $tokens[ $prev ][0] === T_WHITESPACE ) {
						$prev--;
					}
					$is_self_or_static = ( $prev >= 0 && is_array( $tokens[ $prev ] ) && ( $tokens[ $prev ][0] === T_STRING || $tokens[ $prev ][0] === T_STATIC ) && in_array( strtolower( $tokens[ $prev ][1] ), array( 'self', 'static' ), true ) );

					$output .= $text;
					$next = $i + 1;
					$ws = '';
					while ( $next < $count && is_array( $tokens[ $next ] ) && $tokens[ $next ][0] === T_WHITESPACE ) {
						$ws .= $tokens[ $next ][1];
						$next++;
					}
					if ( $next < $count && is_array( $tokens[ $next ] ) ) {
						if ( $tokens[ $next ][0] === T_STRING ) {
							$accessed_name = $tokens[ $next ][1];
							$after_next = $next + 1;
							while ( $after_next < $count && is_array( $tokens[ $after_next ] ) && $tokens[ $after_next ][0] === T_WHITESPACE ) {
								$after_next++;
							}
							$is_method_call = ( $after_next < $count && is_string( $tokens[ $after_next ] ) && $tokens[ $after_next ] === '(' );

							if ( $is_self_or_static && $is_method_call && isset( $private_methods[ $accessed_name ] ) ) {
								$output .= $ws . $private_methods[ $accessed_name ];
								$i = $next;
								continue;
							} elseif ( $is_self_or_static && ! $is_method_call && isset( $private_constants[ $accessed_name ] ) ) {
								$output .= $ws . $private_constants[ $accessed_name ];
								$i = $next;
								continue;
							}
						} elseif ( $tokens[ $next ][0] === T_VARIABLE ) {
							$raw_prop = substr( $tokens[ $next ][1], 1 );
							if ( $is_self_or_static && isset( $private_properties[ $raw_prop ] ) ) {
								$output .= $ws . '$' . $private_properties[ $raw_prop ];
								$i = $next;
								continue;
							} else {
								$output .= $ws . $tokens[ $next ][1];
								$i = $next;
								continue;
							}
						}
					}
					$output .= $ws;
					$i = $next - 1;
					continue;
				}

				// 10. Private Method Declaration
				if ( $id === T_STRING && isset( $private_methods[ $text ] ) ) {
					$prev = $i - 1;
					while ( $prev >= 0 && is_array( $tokens[ $prev ] ) && $tokens[ $prev ][0] === T_WHITESPACE ) {
						$prev--;
					}
					if ( $prev >= 0 && is_array( $tokens[ $prev ] ) && $tokens[ $prev ][0] === T_FUNCTION ) {
						$output .= $private_methods[ $text ];
						continue;
					}
				}

				$output .= $text;
			} else {
				if ( $token === '"' ) {
					$in_double_quote_string = ! $in_double_quote_string;
				}
				$output .= $token;
			}
		}

		if ( ! empty( $declared_classes_in_file ) && $this->flatten_namespaces ) {
			foreach ( $declared_classes_in_file as $fqcn => $info ) {
				$mangled = is_array( $info ) ? $info['mangled'] : $info;
				$type    = is_array( $info ) ? $info['type'] : T_CLASS;
				if ( $type === T_INTERFACE ) {
					$output .= "\nif (interface_exists('" . addslashes( $mangled ) . "', false) && !interface_exists('" . addslashes( $fqcn ) . "', false)) { class_alias('" . addslashes( $mangled ) . "', '" . addslashes( $fqcn ) . "'); }\n";
				} elseif ( $type === T_TRAIT ) {
					$output .= "\nif (trait_exists('" . addslashes( $mangled ) . "', false) && !trait_exists('" . addslashes( $fqcn ) . "', false)) { class_alias('" . addslashes( $mangled ) . "', '" . addslashes( $fqcn ) . "'); }\n";
				} elseif ( defined( 'T_ENUM' ) && $type === T_ENUM ) {
					$output .= "\nif (function_exists('enum_exists') && enum_exists('" . addslashes( $mangled ) . "', false) && !enum_exists('" . addslashes( $fqcn ) . "', false)) { class_alias('" . addslashes( $mangled ) . "', '" . addslashes( $fqcn ) . "'); }\n";
				} else {
					$output .= "\nif (class_exists('" . addslashes( $mangled ) . "', false) && !class_exists('" . addslashes( $fqcn ) . "', false)) { class_alias('" . addslashes( $mangled ) . "', '" . addslashes( $fqcn ) . "'); }\n";
				}
			}
		}



		return array(
			'code'     => $output,
			'manifest' => array(
				'file'           => $file_rel_path,
				'renamedSymbols' => $renamed_symbols,
			),
		);
	}
}

if ( isset( $argv[0] ) && basename( $argv[0] ) === 'transformer.php' ) {
	if ( isset( $argv[1] ) && $argv[1] === '--batch' ) {
		$staging_dir = isset( $argv[2] ) ? $argv[2] : '';
		$map_file    = isset( $argv[3] ) ? $argv[3] : '';
		$seed        = isset( $argv[4] ) ? $argv[4] : 'wpdev-plan3-release';
		$main_file   = isset( $argv[5] ) ? $argv[5] : '';

		if ( empty( $staging_dir ) || ! is_dir( $staging_dir ) ) {
			fwrite( STDERR, "Error: Staging directory not found: $staging_dir\n" );
			exit( 1 );
		}

		$transformer = new Plan3_Transformer( $seed );
		if ( ! empty( $map_file ) ) {
			if ( ! is_file( $map_file ) ) {
				fwrite( STDERR, "Error: Map file not found: $map_file\n" );
				exit( 1 );
			}
			$raw_map = @file_get_contents( $map_file );
			if ( $raw_map === false ) {
				fwrite( STDERR, "Error: Unable to read map file: $map_file\n" );
				exit( 1 );
			}
			$loaded = json_decode( $raw_map, true );
			if ( ! is_array( $loaded ) || ! isset( $loaded['classes'] ) || ! isset( $loaded['functions'] ) ) {
				fwrite( STDERR, "Error: Invalid map file schema in: $map_file\n" );
				exit( 1 );
			}
			$transformer->load_map_from_array( $loaded );
		}

		$iterator = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $staging_dir, RecursiveDirectoryIterator::SKIP_DOTS ) );
		$manifests = array();
		foreach ( $iterator as $file ) {
			if ( $file->isFile() && $file->getExtension() === 'php' ) {
				$path = $file->getPathname();
				if ( strpos( $path, '/vendor/' ) !== false || strpos( $path, '/vendor-prefixed/' ) !== false ) {
					continue;
				}
				$is_main = ! empty( $main_file ) && basename( $path ) === $main_file;
				$source = @file_get_contents( $path );
				if ( $source === false ) {
					fwrite( STDERR, "Error: Failed to read source file: $path\n" );
					exit( 1 );
				}
				$res = $transformer->transform( $source, $is_main, $path );
				if ( ! isset( $res['code'] ) || ! is_string( $res['code'] ) ) {
					fwrite( STDERR, "Error: Transform failed for: $path\n" );
					exit( 1 );
				}
				$expected_len = strlen( $res['code'] );
				$written = @file_put_contents( $path, $res['code'] );
				if ( $written === false || $written !== $expected_len ) {
					fwrite( STDERR, "Error: Failed to write transformed file (written $written of $expected_len bytes): $path\n" );
					exit( 1 );
				}
				$entry = $res['manifest'];
				$entry['sha256'] = hash( 'sha256', $res['code'] );
				$entry['bytes']  = $written;
				$manifests[] = $entry;
			}
		}
		echo json_encode( $manifests ) . "\n";
		exit( 0 );
	}

	if ( isset( $argv[1] ) && $argv[1] === '--dump-map' ) {
		$scan_dir = isset( $argv[2] ) ? $argv[2] : '';
		$map_out  = isset( $argv[3] ) ? $argv[3] : '';
		$seed     = isset( $argv[4] ) ? $argv[4] : 'wpdev-plan3-release';

		if ( empty( $scan_dir ) || ! is_dir( $scan_dir ) ) {
			fwrite( STDERR, "Error: Scan directory not found: $scan_dir\n" );
			exit( 1 );
		}

		$transformer = new Plan3_Transformer( $seed );
		$transformer->scan_symbols_in_dir( $scan_dir );
		$payload = array(
			'classes'   => $transformer->class_map,
			'functions' => $transformer->function_map,
			'constants' => $transformer->constant_map,
			'kinds'     => $transformer->class_kinds,
		);
		$encoded = json_encode( $payload, JSON_PRETTY_PRINT );
		if ( $encoded === false ) {
			fwrite( STDERR, "Error: Failed to JSON encode symbol map\n" );
			exit( 1 );
		}
		$expected_len = strlen( $encoded );
		$written = @file_put_contents( $map_out, $encoded );
		if ( $written === false || $written !== $expected_len ) {
			fwrite( STDERR, "Error: Failed to write symbol map to $map_out\n" );
			exit( 1 );
		}
		echo "DUMPED_MAP_OK\n";
		exit( 0 );
	}

	$target_file = isset( $argv[1] ) ? $argv[1] : '';
	$is_main     = isset( $argv[2] ) && $argv[2] === '--main';
	$third_arg   = isset( $argv[3] ) ? $argv[3] : '';
	$fourth_arg  = isset( $argv[4] ) ? $argv[4] : '';

	$map_file = '';
	$seed     = 'wpdev-plan3-release';

	if ( ! empty( $fourth_arg ) ) {
		$map_file = $third_arg;
		$seed     = $fourth_arg;
	} elseif ( ! empty( $third_arg ) ) {
		if ( substr( $third_arg, -5 ) === '.json' || is_file( $third_arg ) ) {
			$map_file = $third_arg;
		} else {
			$seed = $third_arg;
		}
	}

	if ( empty( $target_file ) || ! is_file( $target_file ) ) {
		fwrite( STDERR, "Usage: php transformer.php <target-file.php> [--main|--not-main] [map-file.json] [seed]\n" );
		exit( 1 );
	}

	$transformer = new Plan3_Transformer( $seed );
	if ( ! empty( $map_file ) ) {
		if ( ! is_file( $map_file ) ) {
			fwrite( STDERR, "Error: Map file not found: $map_file\n" );
			exit( 1 );
		}
		$raw_map = @file_get_contents( $map_file );
		if ( $raw_map === false ) {
			fwrite( STDERR, "Error: Unable to read map file: $map_file\n" );
			exit( 1 );
		}
		$loaded = json_decode( $raw_map, true );
		if ( ! is_array( $loaded ) || ! isset( $loaded['classes'] ) || ! isset( $loaded['functions'] ) ) {
			fwrite( STDERR, "Error: Invalid map file schema in: $map_file\n" );
			exit( 1 );
		}
		$transformer->load_map_from_array( $loaded );
	}
	$source = @file_get_contents( $target_file );
	if ( $source === false ) {
		fwrite( STDERR, "Error: Failed to read target file: $target_file\n" );
		exit( 1 );
	}
	$result = $transformer->transform( $source, $is_main, $target_file );
	if ( ! isset( $result['code'] ) || ! is_string( $result['code'] ) ) {
		fwrite( STDERR, "Error: Transform failed for: $target_file\n" );
		exit( 1 );
	}
	$expected_len = strlen( $result['code'] );
	$written = @file_put_contents( $target_file, $result['code'] );
	if ( $written === false || $written !== $expected_len ) {
		fwrite( STDERR, "Error: Failed to write target file: $target_file\n" );
		exit( 1 );
	}
	$entry = $result['manifest'];
	$entry['sha256'] = hash( 'sha256', $result['code'] );
	$entry['bytes']  = $written;
	echo json_encode( $entry ) . "\n";
}

