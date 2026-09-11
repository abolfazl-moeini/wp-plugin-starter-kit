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

$autoload_candidates = array(
	dirname( __DIR__, 3 ) . '/vendor/autoload.php',
	dirname( __DIR__, 2 ) . '/vendor/autoload.php',
	dirname( __DIR__, 1 ) . '/vendor/autoload.php',
	dirname( __DIR__, 4 ) . '/vendor/autoload.php',
);
foreach ( $autoload_candidates as $autoload ) {
	if ( is_file( $autoload ) ) {
		require_once $autoload;
		break;
	}
}
require_once __DIR__ . '/symbol-analyzer.php';

class Plan3_Transformer {

	protected $seed;
	public $function_map = array();
	public $class_map    = array();
	public $constant_map = array();
	public $class_kinds  = array();
	public $scoped_function_map   = array();
	public $global_function_map   = array();
	public $function_declarations = array();
	public $short_func_counts  = array();
	public $symbols_analyzed   = false;
	public $declarations       = array();
	public $symbol_paths       = array();

	public $private_members = array(
		'methods'    => array(),
		'properties' => array(),
		'constants'  => array(),
	);
	public $preserved_members = array();
	public $class_hierarchy   = array();
	public $project_preserve_config = array(
		'classes'    => array(),
		'functions'  => array(),
		'constants'  => array(),
		'methods'    => array(),
		'properties' => array(),
		'vars'       => array(),
	);

	public $project_global_vars = array();

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
	);

	protected static $frozen_public_constants = array(
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
	);

	public $flatten_namespaces = true;
	public $mangle_symbols = true;
	public $strip_comments = true;
	public $retained_namespaces = array();
	public $classes = array();
	public $accesses_by_offset = array();
	protected $ambiguous_short_names = array();
	protected $class_map_ci = array();

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

	public function __construct( $seed = 'wpdev-plan3-spec', $flatten_namespaces = true, $mangle_symbols = true, $strip_comments = true ) {
		$this->seed = $seed;
		$this->flatten_namespaces = (bool) $flatten_namespaces;
		$this->mangle_symbols = (bool) $mangle_symbols;
		$this->strip_comments = (bool) $strip_comments;
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

	protected function build_class_map_ci() {
		$index = array();
		foreach ( $this->class_map as $symbol => $mangled ) {
			$index[ strtolower( $symbol ) ] = $mangled;
		}
		return $index;
	}

	protected function lookup_class_map( $name ) {
		if ( isset( $this->class_map[ $name ] ) ) {
			return $this->class_map[ $name ];
		}
		$ci = strtolower( $name );
		if ( isset( $this->class_map_ci[ $ci ] ) ) {
			return $this->class_map_ci[ $ci ];
		}
		$prefixed = '\\' . ltrim( $name, '\\' );
		if ( isset( $this->class_map[ $prefixed ] ) ) {
			return $this->class_map[ $prefixed ];
		}
		if ( isset( $this->class_map_ci[ strtolower( $prefixed ) ] ) ) {
			return $this->class_map_ci[ strtolower( $prefixed ) ];
		}
		return null;
	}

	protected function index_accesses( $accesses ) {
		$this->accesses_by_offset = array();
		if ( ! is_array( $accesses ) ) {
			return;
		}
		foreach ( $accesses as $acc ) {
			if ( ! is_array( $acc ) || ! isset( $acc['offset'] ) ) {
				continue;
			}
			$this->accesses_by_offset[ (int) $acc['offset'] ] = $acc;
		}
	}

	protected function next_significant_token( $tokens, $i, $count ) {
		$n = $i + 1;
		while ( $n < $count && is_array( $tokens[ $n ] ) && in_array( $tokens[ $n ][0], array( T_WHITESPACE, T_COMMENT, T_DOC_COMMENT ), true ) ) {
			$n++;
		}
		return $n < $count ? $n : null;
	}

	protected function occurrence_is_function_call( $tokens, $i, $count ) {
		$prev = $this->prev_code_index( $tokens, $i );
		if ( $prev >= 0 && is_array( $tokens[ $prev ] ) ) {
			$classish = array( T_NEW, T_CLASS, T_INTERFACE, T_TRAIT, T_EXTENDS, T_IMPLEMENTS, T_INSTANCEOF, T_DOUBLE_COLON, T_OBJECT_OPERATOR );
			if ( defined( 'T_NULLSAFE_OBJECT_OPERATOR' ) ) {
				$classish[] = T_NULLSAFE_OBJECT_OPERATOR;
			}
			if ( defined( 'T_ENUM' ) ) {
				$classish[] = T_ENUM;
			}
			if ( in_array( $tokens[ $prev ][0], $classish, true ) ) {
				return false;
			}
		}
		$next = $this->next_significant_token( $tokens, $i, $count );
		return $next !== null && is_string( $tokens[ $next ] ) && $tokens[ $next ] === '(';
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
		$open_idx = -1;
		$is_short_array = false;
		while ( $p >= 0 ) {
			$t = $tokens[ $p ];
			if ( is_array( $t ) && $t[0] === T_WHITESPACE ) {
				$p--;
				continue;
			}
			if ( is_string( $t ) && $t === '[' ) {
				$open_idx = $p;
				$is_short_array = true;
				break;
			}
			if ( is_string( $t ) && $t === '(' ) {
				$q = $this->prev_code_index( $tokens, $p );
				if ( $q >= 0 && is_array( $tokens[ $q ] ) && $tokens[ $q ][0] === T_ARRAY ) {
					$open_idx = $q;
					$is_short_array = false;
					break;
				}
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
		if ( $open_idx < 0 ) {
			return false;
		}

		// Check token after closing bracket of array
		$count = count( $tokens );
		$next = $i + 1;
		while ( $next < $count && is_array( $tokens[ $next ] ) && $tokens[ $next ][0] === T_WHITESPACE ) {
			$next++;
		}
		if ( $next < $count && is_string( $tokens[ $next ] ) && $tokens[ $next ] === ',' ) {
			$next = $this->next_significant_token( $tokens, $next, $count );
		}
		if ( $next !== null && $next < $count ) {
			$close_char = $is_short_array ? ']' : ')';
			if ( is_string( $tokens[ $next ] ) && $tokens[ $next ] === $close_char ) {
				$after_close = $this->next_significant_token( $tokens, $next, $count );
				// If followed by subscript '[' or object operator '->', it is data/expression indexing, NOT a callback!
				if ( $after_close !== null && $after_close < $count ) {
					if ( is_string( $tokens[ $after_close ] ) && $tokens[ $after_close ] === '[' ) {
						return false;
					}
					if ( is_array( $tokens[ $after_close ] ) && ( $tokens[ $after_close ][0] === T_OBJECT_OPERATOR || ( defined( 'T_NULLSAFE_OBJECT_OPERATOR' ) && $tokens[ $after_close ][0] === T_NULLSAFE_OBJECT_OPERATOR ) ) ) {
						return false;
					}
				}
			}
		}

		return $this->array_open_in_callback_position( $tokens, $open_idx );
	}

	/**
	 * True when the array literal opening at $open_idx sits in a position that is known to
	 * consume a callable: an argument of a callback-taking function, or the value of a
	 * callback-style array key.
	 *
	 * @param array $tokens
	 * @param int   $open_idx Index of T_ARRAY or of the '[' of a short array.
	 * @return bool
	 */
	protected function array_open_in_callback_position( $tokens, $open_idx ) {
		$before_open = $this->prev_code_index( $tokens, $open_idx );
		if ( $before_open < 0 ) {
			return false;
		}
		if ( is_array( $tokens[ $before_open ] ) && $tokens[ $before_open ][0] === T_DOUBLE_ARROW ) {
			$key_idx = $this->prev_code_index( $tokens, $before_open );
			if ( $key_idx >= 0 && is_array( $tokens[ $key_idx ] ) && $tokens[ $key_idx ][0] === T_CONSTANT_ENCAPSED_STRING ) {
				$k_str = trim( $tokens[ $key_idx ][1], "'\"" );
				return in_array( $k_str, self::$callback_array_keys, true );
			}
			return false;
		}
		if ( ! is_string( $tokens[ $before_open ] ) || ( $tokens[ $before_open ] !== ',' && $tokens[ $before_open ] !== '(' ) ) {
			return false;
		}
		// Start from zero in both cases: the loop counts the enclosing '(' itself when it reaches
		// it. Seeding with 1 for an immediately-preceding '(' double-counted that token, so
		// "paren_depth === 1" was never reached and no callback position ever resolved —
		// add_action('x', array('Cls','m')) was left unrewritten and fatalled at runtime.
		$paren_depth = 0;
		$k          = $before_open;
		while ( $k >= 0 ) {
			if ( is_string( $tokens[ $k ] ) ) {
				if ( $tokens[ $k ] === ')' ) {
					$paren_depth--;
				} elseif ( $tokens[ $k ] === '(' ) {
					$paren_depth++;
					if ( $paren_depth === 1 ) {
						$fn_idx = $this->prev_code_index( $tokens, $k );
						if ( $fn_idx >= 0 ) {
							$fn_name = strtolower( $this->token_function_name( $tokens[ $fn_idx ] ) );
							$callback_funcs = array(
								'add_action',
								'add_filter',
								'remove_action',
								'remove_filter',
								'has_action',
								'has_filter',
								'call_user_func',
								'call_user_func_array',
								'is_callable',
								'register_activation_hook',
								'register_deactivation_hook',
								'register_shutdown_function',
								'array_map',
								'array_filter',
								'usort',
								'uasort',
								'uksort',
							);
							if ( in_array( $fn_name, $callback_funcs, true ) ) {
								return true;
							}
						}
						break;
					}
				}
			}
			$k = $this->prev_code_index( $tokens, $k );
		}

		return false;
	}

	/**
	 * True when the string at $i is the *first* element of a two-element array literal whose
	 * second element is a string, and that array is in a callback position — i.e. the
	 * array('Class', 'method') callable form. The first element carries the class name and must
	 * be remapped like any other class reference; the second element is covered by
	 * is_array_callable_method_string().
	 *
	 * @param array $tokens
	 * @param int   $i
	 * @return bool
	 */
	protected function is_array_callable_class_string( $tokens, $i ) {
		$count = count( $tokens );
		$p     = $this->prev_code_index( $tokens, $i );
		if ( $p < 0 || ! is_string( $tokens[ $p ] ) || ( $tokens[ $p ] !== '(' && $tokens[ $p ] !== '[' ) ) {
			return false;
		}

		if ( $tokens[ $p ] === '(' ) {
			$q = $this->prev_code_index( $tokens, $p );
			if ( $q < 0 || ! is_array( $tokens[ $q ] ) || $tokens[ $q ][0] !== T_ARRAY ) {
				return false;
			}
			$open_idx     = $q;
			$close_marker = ')';
		} else {
			$open_idx     = $p;
			$close_marker = ']';
		}

		// Shape check: string , string <close>
		$n = $this->next_significant_token( $tokens, $i, $count );
		if ( $n === null || ! is_string( $tokens[ $n ] ) || $tokens[ $n ] !== ',' ) {
			return false;
		}
		$n = $this->next_significant_token( $tokens, $n, $count );
		if ( $n === null || ! is_array( $tokens[ $n ] ) || $tokens[ $n ][0] !== T_CONSTANT_ENCAPSED_STRING ) {
			return false;
		}
		$n = $this->next_significant_token( $tokens, $n, $count );
		if ( $n !== null && is_string( $tokens[ $n ] ) && $tokens[ $n ] === ',' ) {
			$n = $this->next_significant_token( $tokens, $n, $count );
		}
		if ( $n === null || ! is_string( $tokens[ $n ] ) || $tokens[ $n ] !== $close_marker ) {
			return false;
		}

		return $this->array_open_in_callback_position( $tokens, $open_idx );
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
		$callback_callers = array(
			'call_user_func',
			'call_user_func_array',
			'add_action',
			'add_filter',
			'register_activation_hook',
			'register_deactivation_hook',
			'function_exists',
			'is_callable',
			'array_map',
			'array_filter',
			'array_walk',
			'array_walk_recursive',
			'usort',
			'uasort',
			'uksort',
			'spl_autoload_register',
			'register_shutdown_function',
			'preg_replace_callback',
			'has_action',
			'has_filter',
			'remove_action',
			'remove_filter',
		);
		return in_array( $fn_name, $callback_callers, true );
	}

	protected function is_array_subscript_string( $tokens, $i ) {
		$p = $this->prev_code_index( $tokens, $i );
		if ( $p < 0 || ! is_string( $tokens[ $p ] ) || $tokens[ $p ] !== '[' ) {
			return false;
		}
		$before = $this->prev_code_index( $tokens, $p );
		if ( $before < 0 ) {
			return false;
		}
		if ( is_string( $tokens[ $before ] ) ) {
			return in_array( $tokens[ $before ], array( ')', ']', '}' ), true );
		}
		if ( is_array( $tokens[ $before ] ) ) {
			$id = $tokens[ $before ][0];
			return ( $id === T_VARIABLE || $id === T_STRING || $id === T_CONSTANT_ENCAPSED_STRING );
		}
		return false;
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
			// Flattened namespaces relocate declarations to global scope; without
			// mangling the declaration keeps its short name, so the old qualified
			// spelling no longer exists. Reference the global short name explicitly.
			if ( $this->flatten_namespaces && ! $this->mangle_symbols && strpos( $target_fqfn, '\\' ) !== false ) {
				$target_ns = substr( $target_fqfn, 0, strrpos( $target_fqfn, '\\' ) );
				if ( ! isset( $this->retained_namespaces[ $target_ns ] ) ) {
					return '\\' . substr( $target_fqfn, strrpos( $target_fqfn, '\\' ) + 1 );
				}
			}
			return $target_fqfn;
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

		if ( isset( $loaded['private_members'] ) && is_array( $loaded['private_members'] ) ) {
			$this->private_members = $loaded['private_members'];
		}
		if ( isset( $loaded['preserved_members'] ) && is_array( $loaded['preserved_members'] ) ) {
			$this->preserved_members = $loaded['preserved_members'];
		}
		if ( isset( $loaded['class_hierarchy'] ) && is_array( $loaded['class_hierarchy'] ) ) {
			$this->class_hierarchy = $loaded['class_hierarchy'];
		}
		if ( isset( $loaded['project_global_vars'] ) && is_array( $loaded['project_global_vars'] ) ) {
			$this->project_global_vars = $loaded['project_global_vars'];
		}
		$this->symbols_analyzed = true;
		$this->class_map_ci = $this->build_class_map_ci();
		if ( isset( $loaded['classes_meta'] ) && is_array( $loaded['classes_meta'] ) ) {
			$this->classes = $loaded['classes_meta'];
		}
		if ( isset( $loaded['__flattenNamespaces'] ) ) {
			$this->flatten_namespaces = (bool) $loaded['__flattenNamespaces'];
		}
		if ( isset( $loaded['__mangleSymbols'] ) ) {
			$this->mangle_symbols = (bool) $loaded['__mangleSymbols'];
		}
		if ( isset( $loaded['__stripComments'] ) ) {
			$this->strip_comments = (bool) $loaded['__stripComments'];
		}
		if ( isset( $loaded['retained_namespaces'] ) && is_array( $loaded['retained_namespaces'] ) ) {
			$this->retained_namespaces = $loaded['retained_namespaces'];
		}

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
			if ( in_array( $dollar, self::$reserved_vars, true ) || isset( $this->project_global_vars[ $dollar ] ) ) {
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

	public function detect_retained_namespaces_in_tokens( array $tokens ) {
		$retained = array();
		$count    = count( $tokens );
		$current_ns = '';
		$in_class   = 0;
		$class_depth = 0;
		$ns_brace_depth = 0;
		$ns_blocks = array();
		$has_bracketed_ns = false;

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
							$current_ns = '';
						}
					}
				}
				continue;
			}
			$id = $token[0];
			if ( $id === T_NAMESPACE ) {
				$spec = $this->read_namespace_spec( $tokens, $i, $count );
				$current_ns = $spec['name'];
				if ( $spec['terminator'] === '{' ) {
					$has_bracketed_ns = true;
					$ns_blocks[ $spec['name'] ] = true;
					$ns_brace_depth = 1;
				} elseif ( $spec['name'] !== '' ) {
					$ns_blocks[ $spec['name'] ] = true;
				}
				$i = $spec['end'];
				continue;
			}
			if ( empty( $current_ns ) ) {
				continue;
			}
			if ( $id === T_NS_C || $id === T_CLASS_C || $id === T_METHOD_C ) {
				$retained[ $current_ns ] = true;
			} elseif ( $id === T_CONST && $class_depth === 0 && $in_class === 0 ) {
				$prev_const = $i - 1;
				while ( $prev_const >= 0 && is_array( $tokens[ $prev_const ] ) && $tokens[ $prev_const ][0] === T_WHITESPACE ) {
					$prev_const--;
				}
				$vis = array( T_PUBLIC, T_PROTECTED, T_PRIVATE );
				if ( defined( 'T_FINAL' ) ) {
					$vis[] = T_FINAL;
				}
				if ( $prev_const < 0 || ! is_array( $tokens[ $prev_const ] ) || ! in_array( $tokens[ $prev_const ][0], $vis, true ) ) {
					$retained[ $current_ns ] = true;
				}
			} elseif ( $id === T_CLASS || $id === T_INTERFACE || $id === T_TRAIT || ( defined( 'T_ENUM' ) && $id === T_ENUM ) ) {
				$prev = $i - 1;
				while ( $prev >= 0 && is_array( $tokens[ $prev ] ) && $tokens[ $prev ][0] === T_WHITESPACE ) {
					$prev--;
				}
				if ( $prev >= 0 && is_array( $tokens[ $prev ] ) && $tokens[ $prev ][0] === T_DOUBLE_COLON ) {
					continue;
				}
				$in_class = 1;
				$next = $i + 1;
				while ( $next < $count && is_array( $tokens[ $next ] ) && ( $tokens[ $next ][0] === T_WHITESPACE || $tokens[ $next ][0] === T_STATIC || $tokens[ $next ][0] === T_ABSTRACT || $tokens[ $next ][0] === T_FINAL ) ) {
					$next++;
				}
				if ( $next < $count && is_array( $tokens[ $next ] ) && in_array( $tokens[ $next ][1], self::$frozen_public_classes, true ) ) {
					$retained[ $current_ns ] = true;
				}
			}
		}
		// When a file declares more than one namespace block, flattening some and retaining
		// others breaks: removing a later namespace declaration leaves its declarations inside
		// the earlier retained namespace (R06). Fail-safe: keep all namespace blocks.
		if ( count( $ns_blocks ) > 1 || ( $has_bracketed_ns && ! empty( $retained ) ) ) {
			foreach ( array_keys( $ns_blocks ) as $ns ) {
				$retained[ $ns ] = true;
			}
		}
		return $retained;
	}

	public function scan_symbols_in_dir( $dir ) {
		$this->ambiguous_short_names = array();
		$this->short_func_counts     = array();
		$this->function_declarations = array();
		$php_files = array();
		$it = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $dir, RecursiveDirectoryIterator::SKIP_DOTS ) );
		foreach ( $it as $file ) {
			$pathname = str_replace( '\\', '/', $file->getPathname() );
			if ( strpos( $pathname, '/vendor/' ) !== false || strpos( $pathname, '/vendor-prefixed/' ) !== false ) {
				continue;
			}
			if ( $file->isFile() && $file->getExtension() === 'php' ) {
				$php_files[] = $file->getPathname();
				$src = @file_get_contents( $file->getPathname() );
				if ( $src !== false ) {
					$toks = token_get_all( $src );
					$detected = $this->detect_retained_namespaces_in_tokens( $toks );
					foreach ( $detected as $ns => $val ) {
						$this->retained_namespaces[ $ns ] = true;
					}
				}
			}
		}
		foreach ( $php_files as $php_file ) {
			$this->scan_file_symbols( $php_file );
		}

		$analyzer = new Plan3_Symbol_Analyzer( $this->seed );
		$analyzer->analyze_directory( $dir );
		$this->private_members     = $analyzer->private_members;
		$this->preserved_members   = $analyzer->preserved_members;
		$this->class_hierarchy     = $analyzer->class_hierarchy;
		$this->project_global_vars = $analyzer->project_global_vars;
		$this->classes             = $analyzer->classes;
		$this->index_accesses( $analyzer->accesses );
		$this->class_map_ci        = $this->build_class_map_ci();
		if ( ! $this->mangle_symbols ) {
			$this->private_members = array(
				'methods'    => array(),
				'properties' => array(),
				'constants'  => array(),
			);
		} else {
			foreach ( $analyzer->classes as $fqcn => $class ) {
				$methods = isset( $class['methods'] ) ? $class['methods'] : array();
				$short_name = substr( strrchr( $fqcn, '\\' ) ?: ( '\\' . $fqcn ), 1 );
				$is_serialized = isset( $methods['__sleep'] )
					|| isset( $methods['__serialize'] )
					|| isset( $methods['__wakeup'] )
					|| isset( $methods['__unserialize'] )
					|| isset( $analyzer->serialized_classes[ $fqcn ] )
					|| isset( $analyzer->serialized_classes[ $short_name ] );

				if ( $is_serialized ) {
					foreach ( array_keys( $this->class_map ) as $mapped ) {
						$clean = ltrim( $mapped, '\\' );
						if ( strcasecmp( $clean, $fqcn ) === 0 || strcasecmp( $clean, $short_name ) === 0 ) {
							unset( $this->class_map[ $mapped ] );
						}
					}
					if ( isset( $this->short_class_names[ $short_name ] ) ) {
						unset( $this->short_class_names[ $short_name ] );
					}
					if ( isset( $class['properties'] ) && is_array( $class['properties'] ) ) {
						foreach ( $class['properties'] as $p_name => $_meta ) {
							$this->preserved_members[ $fqcn ]['properties'][ $p_name ] = 'serialization_identity';
							if ( isset( $this->private_members['properties'][ $fqcn ][ $p_name ] ) ) {
								unset( $this->private_members['properties'][ $fqcn ][ $p_name ] );
							}
						}
					}
				}
			}
			$this->class_map_ci = $this->build_class_map_ci();
		}
		$this->symbols_analyzed    = true;
	}

	/**
	 * Split a namespace use-statement body on top-level commas.
	 * Commas inside group-use braces (use Foo\{A, B}) do not split.
	 */
	protected function split_use_statement_clauses( $inner ) {
		$clauses = array();
		$depth   = 0;
		$current = '';
		$len     = strlen( $inner );
		for ( $k = 0; $k < $len; $k++ ) {
			$ch = $inner[ $k ];
			if ( $ch === '{' ) {
				$depth++;
			} elseif ( $ch === '}' ) {
				$depth = max( 0, $depth - 1 );
			}
			if ( $ch === ',' && $depth === 0 ) {
				$clauses[] = $current;
				$current   = '';
			} else {
				$current .= $ch;
			}
		}
		if ( trim( $current ) !== '' ) {
			$clauses[] = $current;
		}
		return $clauses;
	}

	/**
	 * Expand one group-use clause (use Foo\{Bar, function baz, const QUX})
	 * into individual single-import clause strings. Non-group clauses pass
	 * through unchanged. Supports mixed group-use member prefixes.
	 */
	protected function expand_group_use_clause( $clause ) {
		$clause = trim( $clause );
		if ( strpos( $clause, '{' ) === false ) {
			return array( $clause );
		}
		if ( ! preg_match( '/^(function\s+|const\s+)?([a-zA-Z0-9_\\\\]+)\\{(.+)\\}$/is', $clause, $m ) ) {
			return array( $clause );
		}
		$outer_kind = isset( $m[1] ) ? strtolower( trim( $m[1] ) ) : '';
		$prefix     = rtrim( $m[2], '\\' );
		$expanded   = array();
		foreach ( $this->split_use_statement_clauses( $m[3] ) as $member ) {
			$member = trim( $member );
			$kind   = $outer_kind;
			if ( preg_match( '/^(function|const)\s+(.+)$/is', $member, $mm ) ) {
				$kind   = strtolower( $mm[1] );
				$member = trim( $mm[2] );
			}
			$name  = $member;
			$alias = '';
			if ( preg_match( '/^(.+?)\s+as\s+([a-zA-Z0-9_]+)$/is', $member, $ma ) ) {
				$name  = trim( $ma[1] );
				$alias = $ma[2];
			}
			$fq         = $prefix . '\\' . ltrim( $name, '\\' );
			$expanded[] = ( $kind !== '' ? $kind . ' ' : '' ) . $fq . ( $alias !== '' ? ' as ' . $alias : '' );
		}
		return $expanded;
	}

	/**
	 * Brace-aware split of a full use-statement body plus group expansion.
	 */
	protected function expand_use_statement_clauses( $inner ) {
		$out = array();
		foreach ( $this->split_use_statement_clauses( $inner ) as $clause ) {
			foreach ( $this->expand_group_use_clause( $clause ) as $expanded ) {
				$out[] = $expanded;
			}
		}
		return $out;
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

				if ( $id === T_GLOBAL ) {
					$k = $i + 1;
					while ( $k < $count && ( ! is_string( $tokens[ $k ] ) || $tokens[ $k ] !== ';' ) ) {
						if ( is_array( $tokens[ $k ] ) && $tokens[ $k ][0] === T_VARIABLE ) {
							$this->project_global_vars[ $tokens[ $k ][1] ] = true;
						}
						$k++;
					}
				} elseif ( $id === T_NAMESPACE ) {
					$spec = $this->read_namespace_spec( $tokens, $i, $count );
					$current_namespace = $spec['name'];
					if ( $spec['terminator'] === '{' ) {
						$ns_brace_depth = 1;
					}
					$i = $spec['end'];
				} elseif ( $id === T_CLASS || $id === T_INTERFACE || $id === T_TRAIT || ( defined( 'T_ENUM' ) && $id === T_ENUM ) ) {
					$prev = $i - 1;
					while ( $prev >= 0 && is_array( $tokens[ $prev ] ) && $tokens[ $prev ][0] === T_WHITESPACE ) {
						$prev--;
					}
					if ( $prev >= 0 && is_array( $tokens[ $prev ] ) && $tokens[ $prev ][0] === T_DOUBLE_COLON ) {
						continue;
					}
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
						$class_line = isset( $tokens[ $next ][2] ) ? $tokens[ $next ][2] : 1;
						$hash_key   = ! empty( $current_namespace ) ? ( $current_namespace . '\\' . $class_name ) : $class_name;
						$this->class_kinds[ $hash_key ] = $kind;
						$is_frozen = in_array( $class_name, self::$frozen_public_classes, true );
						$this->symbol_paths[ $hash_key ] = $file_path . ':' . $class_line;
						$this->declarations[] = array(
							'symbol'               => $hash_key,
							'name'                 => $class_name,
							'namespace'            => $current_namespace,
							'kind'                 => $kind,
							'file'                 => $file_path,
							'line'                 => $class_line,
							'is_global'            => empty( $current_namespace ),
							'is_alias'             => false,
							'frozen'               => $is_frozen,
							'effectiveDestination' => ! $this->mangle_symbols || $is_frozen ? $class_name : '',
						);
						if ( $is_frozen ) {
							continue;
						}

						// Pre-scan class body for T_CLASS_C / T_METHOD_C
						$uses_class_magic = false;
						$brace_count = 0;
						$has_opened  = false;
						for ( $ci = $next + 1; $ci < $count; $ci++ ) {
							if ( is_string( $tokens[ $ci ] ) ) {
								if ( $tokens[ $ci ] === '{' ) {
									$brace_count++;
									$has_opened = true;
								} elseif ( $tokens[ $ci ] === '}' ) {
									$brace_count--;
									if ( $has_opened && $brace_count === 0 ) {
										break;
									}
								}
							} elseif ( is_array( $tokens[ $ci ] ) ) {
								if ( $tokens[ $ci ][0] === T_CLASS_C || $tokens[ $ci ][0] === T_METHOD_C ) {
									$uses_class_magic = true;
									break;
								}
							}
						}

						if ( $uses_class_magic ) {
							if ( ! empty( $current_namespace ) ) {
								$this->retained_namespaces[ $current_namespace ] = true;
							}
							continue;
						}
						$is_flattened = $this->flatten_namespaces && ( empty( $current_namespace ) || ! isset( $this->retained_namespaces[ $current_namespace ] ) );
						if ( ! $this->mangle_symbols ) {
							if ( $is_flattened ) {
								$this->record_short_class_name( $class_name, $class_name );
								if ( ! empty( $current_namespace ) ) {
									$fqcn = $current_namespace . '\\' . $class_name;
									$this->class_map[ $fqcn ] = $class_name;
									$this->class_map[ '\\' . $fqcn ] = '\\' . $class_name;
								}
							} else {
								if ( ! empty( $current_namespace ) ) {
									$fqcn = $current_namespace . '\\' . $class_name;
									$this->class_map[ $fqcn ] = $fqcn;
									$this->class_map[ '\\' . $fqcn ] = '\\' . $fqcn;
								}
							}
							continue;
						}
						$mangled = '_c_' . substr( hash( 'sha256', $this->seed . ':class:' . $hash_key ), 0, 8 );

						if ( $is_flattened ) {
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
						while ( $next < $count ) {
							$nt     = $tokens[ $next ];
							$is_ws  = is_array( $nt ) && $nt[0] === T_WHITESPACE;
							// Return-by-reference marker: plain '&' on PHP 7.4,
							// T_AMPERSAND_* array tokens on PHP 8.1+.
							$is_amp = ( is_string( $nt ) && $nt === '&' ) || ( is_array( $nt ) && $nt[1] === '&' );
							if ( ! $is_ws && ! $is_amp ) {
								break;
							}
							$next++;
						}
						if ( $next < $count && is_array( $tokens[ $next ] ) && $tokens[ $next ][0] === T_STRING ) {
							$func_name   = $tokens[ $next ][1];
							$func_line   = isset( $tokens[ $next ][2] ) ? $tokens[ $next ][2] : 1;
							$fqfn        = ! empty( $current_namespace ) ? ( $current_namespace . '\\' . $func_name ) : $func_name;
							$is_reserved = in_array( strtolower( $func_name ), array_map( 'strtolower', self::$reserved_funcs ), true )
								|| strpos( $func_name, 'wpdev_' ) === 0 || strpos( $func_name, '_wpdev_' ) === 0 || strpos( $func_name, 'tavangary_' ) === 0;
						$this->symbol_paths[ $fqfn ] = $file_path . ':' . $func_line;
						$this->declarations[] = array(
							'symbol'               => $fqfn,
							'name'                 => $func_name,
							'namespace'            => $current_namespace,
							'kind'                 => 'function',
							'file'                 => $file_path,
								'line'                 => $func_line,
								'is_global'            => empty( $current_namespace ),
								'is_alias'             => false,
								'frozen'               => $is_reserved,
								'effectiveDestination' => ! $this->mangle_symbols || $is_reserved ? $func_name : '',
							);
							if ( $is_reserved ) {
								continue;
							}
							if ( ! $this->mangle_symbols ) {
								continue;
							}
						$this->function_declarations[] = array(
							'fqfn'      => $fqfn,
							'namespace' => $current_namespace,
							'name'      => $func_name,
							'file'      => $file_path,
						);
							$mangled = '_f_' . substr( hash( 'sha256', $this->seed . ':func:' . strtolower( $fqfn ) ), 0, 8 );

							$is_flattened = $this->flatten_namespaces && ( empty( $current_namespace ) || ! isset( $this->retained_namespaces[ $current_namespace ] ) );
							if ( $is_flattened ) {
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
				} elseif ( $id === T_CONST && $class_depth === 0 && $in_class === 0 ) {
					$prev_const = $i - 1;
					while ( $prev_const >= 0 && is_array( $tokens[ $prev_const ] ) && $tokens[ $prev_const ][0] === T_WHITESPACE ) {
						$prev_const--;
					}
					$vis = array( T_PUBLIC, T_PROTECTED, T_PRIVATE );
					if ( defined( 'T_FINAL' ) ) {
						$vis[] = T_FINAL;
					}
					if ( $prev_const < 0 || ! is_array( $tokens[ $prev_const ] ) || ! in_array( $tokens[ $prev_const ][0], $vis, true ) ) {
						$next = $i + 1;
						while ( $next < $count && is_array( $tokens[ $next ] ) && $tokens[ $next ][0] === T_WHITESPACE ) {
							$next++;
						}
						if ( $next < $count && is_array( $tokens[ $next ] ) && $tokens[ $next ][0] === T_STRING ) {
							$const_name = $tokens[ $next ][1];
							$const_line = isset( $tokens[ $next ][2] ) ? $tokens[ $next ][2] : 1;
							$fqcn_const = ! empty( $current_namespace ) ? ( $current_namespace . '\\' . $const_name ) : $const_name;
						$this->symbol_paths[ $fqcn_const ] = $file_path . ':' . $const_line;
						$this->declarations[] = array(
							'symbol'               => $fqcn_const,
							'name'                 => $const_name,
							'namespace'            => $current_namespace,
							'kind'                 => 'constant',
							'file'                 => $file_path,
								'line'                 => $const_line,
								'is_global'            => empty( $current_namespace ),
								'is_alias'             => false,
								'frozen'               => false,
								'effectiveDestination' => ! $this->mangle_symbols ? $const_name : '',
							);
						}
					}
				}
			}
		}
	}

	public function transform( $source, $is_main_plugin_file = false, $file_rel_path = '' ) {
		$file_key = $file_rel_path ? $file_rel_path : 'main.php';

		$analyzer = new Plan3_Symbol_Analyzer( $this->seed );
		if ( ! empty( $this->project_global_vars ) ) {
			$analyzer->project_global_vars = $this->project_global_vars;
		}
		if ( ! empty( $this->classes ) ) {
			$analyzer->classes = $this->classes;
		}
		$directory_member_plan = ( ! empty( $this->private_members['methods'] ) || ! empty( $this->private_members['properties'] ) || ! empty( $this->private_members['constants'] ) || ! empty( $this->preserved_members ) );
		if ( $directory_member_plan ) {
			$analyzer->private_members   = $this->private_members;
			$analyzer->preserved_members = $this->preserved_members;
			$analyzer->class_hierarchy   = $this->class_hierarchy;
		}

		$analyzer->analyze_code( $source, $file_key, ! $directory_member_plan );

		if ( ! $directory_member_plan ) {
			$this->private_members   = $analyzer->private_members;
			$this->preserved_members = $analyzer->preserved_members;
			$this->class_hierarchy   = $analyzer->class_hierarchy;
			$this->classes           = $analyzer->classes;
		}
		$this->project_global_vars = array_merge( $this->project_global_vars, $analyzer->project_global_vars );
		$this->index_accesses( $analyzer->accesses );
		$this->class_map_ci     = $this->build_class_map_ci();
		$this->symbols_analyzed = true;

		$var_decisions     = isset( $analyzer->file_var_decisions[ $file_key ] ) ? $analyzer->file_var_decisions[ $file_key ] : array();
		$compact_decisions = isset( $analyzer->file_compact_decisions[ $file_key ] ) ? $analyzer->file_compact_decisions[ $file_key ] : array();
		if ( ! $this->mangle_symbols ) {
			$var_decisions     = array();
			$compact_decisions = array();
		}

		$tokens = token_get_all( $source );
		$count  = count( $tokens );

		$token_offsets = array();
		$offset = 0;
		for ( $t_idx = 0; $t_idx < $count; $t_idx++ ) {
			$token_offsets[ $t_idx ] = $offset;
			$offset += is_array( $tokens[ $t_idx ] ) ? strlen( $tokens[ $t_idx ][1] ) : strlen( $tokens[ $t_idx ] );
		}

		$renamed_symbols           = array();
		$declared_functions_in_file = array();
		$current_namespace         = '';
		$norm_rel_path             = str_replace( '\\', '/', (string) $file_rel_path );
		$is_view_file              = ( strpos( $norm_rel_path, 'views/' ) !== false || strpos( $norm_rel_path, 'templates/' ) !== false || strpos( $norm_rel_path, 'FrameworkClosure/views/' ) !== false );

		$preserved_vars   = array();
		$dynamic_scopes   = array();
		$token_scopes     = array();
		$scope_stack      = array( 0 );
		$current_scope_id = 0;
		$next_scope_id    = 1;
		$pending_scope_id = null;

		// Pass 1: Track scopes with dynamic variable introspection.
		$pass1_interp_depth = 0;
		for ( $i = 0; $i < $count; $i++ ) {
			$token = $tokens[ $i ];
			if ( is_string( $token ) ) {
				if ( $pass1_interp_depth > 0 ) {
					if ( $token === '{' ) {
						$pass1_interp_depth++;
					} elseif ( $token === '}' ) {
						$pass1_interp_depth--;
					}
					$token_scopes[ $i ] = ( $pending_scope_id !== null ) ? $pending_scope_id : $current_scope_id;
					continue;
				}
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
						$this->project_global_vars[ $tokens[ $k ][1] ] = true;
					}
					$k++;
				}
			} elseif ( ( $id === T_STRING && strtolower( $token[1] ) === 'extract' ) ||
			           ( defined( 'T_NAME_FULLY_QUALIFIED' ) && $id === T_NAME_FULLY_QUALIFIED && strtolower( ltrim( $token[1], '\\' ) ) === 'extract' ) ) {
				$p = $this->prev_code_index( $tokens, $i );
				$is_method = ( $p >= 0 && is_array( $tokens[ $p ] ) && in_array( $tokens[ $p ][0], array( T_OBJECT_OPERATOR, defined( 'T_NULLSAFE_OBJECT_OPERATOR' ) ? T_NULLSAFE_OBJECT_OPERATOR : -1, T_DOUBLE_COLON ), true ) );
				if ( ! $is_method ) {
					$dynamic_scopes[ $current_scope_id ] = true;
				}
			} elseif ( ( $id === T_STRING && strtolower( $token[1] ) === 'get_defined_vars' ) ||
			           ( defined( 'T_NAME_FULLY_QUALIFIED' ) && $id === T_NAME_FULLY_QUALIFIED && strtolower( ltrim( $token[1], '\\' ) ) === 'get_defined_vars' ) ) {
				$p = $this->prev_code_index( $tokens, $i );
				$is_method = ( $p >= 0 && is_array( $tokens[ $p ] ) && in_array( $tokens[ $p ][0], array( T_OBJECT_OPERATOR, defined( 'T_NULLSAFE_OBJECT_OPERATOR' ) ? T_NULLSAFE_OBJECT_OPERATOR : -1, T_DOUBLE_COLON ), true ) );
				if ( ! $is_method ) {
					$dynamic_scopes[ $current_scope_id ] = true;
				}
			} elseif ( in_array( $id, array( T_INCLUDE, T_INCLUDE_ONCE, T_REQUIRE, T_REQUIRE_ONCE ), true ) ) {
				$dynamic_scopes[ $current_scope_id ] = true;
			} elseif ( ( $id === T_STRING && strtolower( $token[1] ) === 'compact' ) ||
			           ( defined( 'T_NAME_FULLY_QUALIFIED' ) && $id === T_NAME_FULLY_QUALIFIED && strtolower( ltrim( $token[1], '\\' ) ) === 'compact' ) ) {
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
				$pass1_interp_depth++;
			} elseif ( defined( 'T_CURLY_OPEN' ) && $id === T_CURLY_OPEN ) {
				$pass1_interp_depth++;
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
					$clauses = $this->expand_use_statement_clauses( $use_str );
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

		$detected_retained = $this->detect_retained_namespaces_in_tokens( $tokens );
		foreach ( $detected_retained as $ns => $val ) {
			$this->retained_namespaces[ $ns ] = true;
		}
		$keep_namespace = false;
		$file_retained_namespaces = array();

		// Pass 2: Reconstruct code
		$output                 = '';
		$in_double_quote_string = false;
		$seen_first_docblock    = false;
		$current_namespace      = '';
		$in_class               = false;
		$class_brace_depth      = 0;
		$class_stack            = array();
		$pending_class_fqcn     = null;
		$in_function_header     = false;
		$declared_classes_in_file = array();
		$pending_ns_brace       = false;
		$ns_brace_depth         = 0;
		$retained_brace_namespace_emitted = false;
		$current_class_fqcn     = '';
		$pass2_interp_depth     = 0;

		for ( $i = 0; $i < $count; $i++ ) {
			$token = $tokens[ $i ];

			if ( is_string( $token ) ) {
				if ( $pass2_interp_depth > 0 ) {
					if ( $token === '{' ) {
						$pass2_interp_depth++;
					} elseif ( $token === '}' ) {
						$pass2_interp_depth--;
					}
					$output .= $token;
					continue;
				}
				if ( $token === '{' ) {
					$in_function_header = false;
					if ( $pending_ns_brace ) {
						$pending_ns_brace = false;
						$ns_brace_depth   = 1;
						if ( $this->flatten_namespaces && ! $keep_namespace ) {
							continue;
						}
					} else {
						if ( $pending_class_fqcn !== null ) {
							array_push( $class_stack, array( 'fqcn' => $pending_class_fqcn, 'depth' => 1 ) );
							$current_class_fqcn = $pending_class_fqcn;
							$in_class           = true;
							$class_brace_depth  = 1;
							$pending_class_fqcn = null;
						} elseif ( ! empty( $class_stack ) ) {
							$top_idx = count( $class_stack ) - 1;
							$class_stack[ $top_idx ]['depth']++;
							$class_brace_depth = $class_stack[ $top_idx ]['depth'];
						}
						if ( $ns_brace_depth > 0 ) {
							$ns_brace_depth++;
						}
					}
				} elseif ( $token === '}' ) {
					$in_function_header = false;
					$closing_ns = false;
					$closing_keep_ns = false;
					if ( $ns_brace_depth > 0 ) {
						$ns_brace_depth--;
						if ( $ns_brace_depth === 0 ) {
							$closing_ns          = true;
							$closing_keep_ns     = $keep_namespace;
							$current_namespace   = '';
							$keep_namespace      = false;
						}
					}
					if ( ! empty( $class_stack ) ) {
						$top_idx = count( $class_stack ) - 1;
						$class_stack[ $top_idx ]['depth']--;
						if ( $class_stack[ $top_idx ]['depth'] <= 0 ) {
							array_pop( $class_stack );
						}
						$current_class_fqcn = ! empty( $class_stack ) ? $class_stack[ count( $class_stack ) - 1 ]['fqcn'] : '';
						$in_class           = ! empty( $class_stack );
						$class_brace_depth  = ! empty( $class_stack ) ? $class_stack[ count( $class_stack ) - 1 ]['depth'] : 0;
					}
					if ( $closing_ns && $this->flatten_namespaces && ! $closing_keep_ns ) {
						continue;
					}
				} elseif ( $token === ';' ) {
					$in_function_header = false;
				}
			}

			if ( is_array( $token ) ) {
				$id   = $token[0];
				$text = $token[1];

				if ( $id === T_CLASS || $id === T_INTERFACE || $id === T_TRAIT || ( defined( 'T_ENUM' ) && $id === T_ENUM ) ) {
					$prev = $i - 1;
					while ( $prev >= 0 && is_array( $tokens[ $prev ] ) && $tokens[ $prev ][0] === T_WHITESPACE ) {
						$prev--;
					}
					$is_after_dc = ( $prev >= 0 && is_array( $tokens[ $prev ] ) && $tokens[ $prev ][0] === T_DOUBLE_COLON );
					if ( ! $is_after_dc ) {
						$next = $i + 1;
						while ( $next < $count && is_array( $tokens[ $next ] ) && ( $tokens[ $next ][0] === T_WHITESPACE || $tokens[ $next ][0] === T_STATIC || $tokens[ $next ][0] === T_ABSTRACT || $tokens[ $next ][0] === T_FINAL ) ) {
							$next++;
						}
						if ( $next < $count && is_array( $tokens[ $next ] ) && $tokens[ $next ][0] === T_STRING ) {
							$raw_class_name = $tokens[ $next ][1];
							$pending_class_fqcn = ! empty( $current_namespace ) ? ( $current_namespace . '\\' . $raw_class_name ) : $raw_class_name;
						} else {
							$pending_class_fqcn = 'anonymous@' . $i;
						}
					}
				}

				if ( $id === T_FUNCTION || ( defined( 'T_FN' ) && $id === T_FN ) ) {
					$in_function_header = true;
				} elseif ( $id === T_DOUBLE_ARROW ) {
					$in_function_header = false;
				} elseif ( ( defined( 'T_CURLY_OPEN' ) && $id === T_CURLY_OPEN ) || ( defined( 'T_DOLLAR_OPEN_CURLY_BRACES' ) && $id === T_DOLLAR_OPEN_CURLY_BRACES ) ) {
					$pass2_interp_depth++;
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
						$keep_namespace = ( ! empty( $current_namespace ) && isset( $this->retained_namespaces[ $current_namespace ] ) )
							|| ( $current_namespace === '' && $pending_ns_brace && ( isset( $this->retained_namespaces[''] ) || $retained_brace_namespace_emitted ) );
						if ( $keep_namespace ) {
							$file_retained_namespaces[] = $current_namespace;
						}
						if ( ! $this->flatten_namespaces || $keep_namespace ) {
							if ( $pending_ns_brace ) {
								$retained_brace_namespace_emitted = true;
							}
							$output .= ( $current_namespace !== '' ) ? ( 'namespace ' . $current_namespace ) : 'namespace';
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
							if ( ! $in_value && $bracket_depth === 0 && $t[0] === T_STRING && ! empty( $current_class_fqcn ) && isset( $this->private_members['constants'][ $current_class_fqcn ][ $t[1] ] ) ) {
								$output .= $this->private_members['constants'][ $current_class_fqcn ][ $t[1] ];
							} elseif ( $in_value && ( $t[0] === T_STRING || ( defined( 'T_NAME_QUALIFIED' ) && $t[0] === T_NAME_QUALIFIED ) ) ) {
								// Check if preceded by :: (e.g. self::SECRET or Vault::SECRET)
								$prev_tok_idx = $j - 1;
								while ( $prev_tok_idx >= $i && is_array( $tokens[ $prev_tok_idx ] ) && $tokens[ $prev_tok_idx ][0] === T_WHITESPACE ) {
									$prev_tok_idx--;
								}
								$is_after_dc = ( $prev_tok_idx >= $i && is_array( $tokens[ $prev_tok_idx ] ) && $tokens[ $prev_tok_idx ][0] === T_DOUBLE_COLON );
								$handled_const_ref = false;

								if ( $is_after_dc ) {
									$before_dc = $prev_tok_idx - 1;
									while ( $before_dc >= $i && is_array( $tokens[ $before_dc ] ) && $tokens[ $before_dc ][0] === T_WHITESPACE ) {
										$before_dc--;
									}
									$target_class = '';
									if ( $before_dc >= $i && is_array( $tokens[ $before_dc ] ) ) {
										$b_text = strtolower( $tokens[ $before_dc ][1] );
										if ( $b_text === 'self' || $b_text === 'static' ) {
											$target_class = $current_class_fqcn;
										} elseif ( isset( $this->class_map[ $tokens[ $before_dc ][1] ] ) || isset( $this->class_map[ $current_namespace . '\\' . $tokens[ $before_dc ][1] ] ) ) {
											$target_class = ! empty( $current_namespace ) && isset( $this->class_map[ $current_namespace . '\\' . $tokens[ $before_dc ][1] ] )
												? ( $current_namespace . '\\' . $tokens[ $before_dc ][1] )
												: $tokens[ $before_dc ][1];
										} else {
											$target_class = $tokens[ $before_dc ][1];
										}
									}
									if ( ! empty( $target_class ) && isset( $this->private_members['constants'][ $target_class ][ $t[1] ] ) ) {
										$output .= $this->private_members['constants'][ $target_class ][ $t[1] ];
										$handled_const_ref = true;
									}
								}

								if ( ! $handled_const_ref ) {
									if ( isset( $file_use_map[ $t[1] ] ) && isset( $this->class_map[ $file_use_map[ $t[1] ] ] ) ) {
										$target = $this->class_map[ $file_use_map[ $t[1] ] ];
										$output .= ( $this->flatten_namespaces && ! empty( $current_namespace ) && ! $keep_namespace ) ? ( '\\' . $target ) : $target;
									} elseif ( ! empty( $current_namespace ) && isset( $this->class_map[ $current_namespace . '\\' . $t[1] ] ) ) {
										$target = $this->class_map[ $current_namespace . '\\' . $t[1] ];
										if ( ! $this->flatten_namespaces && strncmp( $target, $current_namespace . '\\', strlen( $current_namespace ) + 1 ) === 0 ) {
											$output .= substr( $target, strlen( $current_namespace ) + 1 );
										} else {
											$output .= ( $this->flatten_namespaces && ! empty( $current_namespace ) && ! $keep_namespace ) ? ( '\\' . $target ) : $target;
										}
									} elseif ( isset( $this->class_map[ $t[1] ] ) ) {
										$target = $this->class_map[ $t[1] ];
										$output .= ( $this->flatten_namespaces && ! empty( $current_namespace ) && ! $keep_namespace ) ? ( '\\' . $target ) : $target;
									} else {
										$output .= $t[1];
									}
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

						$use_inner_raw = '';
						foreach ( $use_statement_tokens as $ut ) {
							$use_inner_raw .= is_array( $ut ) ? ( ( $ut[0] === T_WHITESPACE ) ? ' ' : $ut[1] ) : $ut;
						}
						$use_has_group = ( strpos( $use_inner_raw, '{' ) !== false );

						if ( $use_has_group && $this->flatten_namespaces && ! $keep_namespace ) {
							// Grouped use under flattening: expand members and apply
							// the same per-import preserve/drop decisions as singles.
							$preserved_clauses = array();
							foreach ( $this->expand_use_statement_clauses( $use_inner_raw ) as $expanded ) {
								if ( preg_match( '/^(function|const)\s+/i', $expanded ) ) {
									$preserved_clauses[] = $expanded;
									continue;
								}
								if ( preg_match( '/^\\\\?([a-zA-Z0-9_\\\\]+)(?:\s+as\s+([a-zA-Z0-9_]+))?$/i', $expanded, $gm ) ) {
									$group_target = ltrim( $gm[1], '\\' );
									if ( ! isset( $this->class_map[ $group_target ] ) && ! isset( $this->class_map[ '\\' . $group_target ] ) && strpos( $group_target, '\\' ) !== false ) {
										$preserved_clauses[] = $expanded;
									}
								} else {
									$preserved_clauses[] = $expanded;
								}
							}
							// One statement per member: repeating the function/const
							// keyword inside a comma list is a parse error.
							foreach ( $preserved_clauses as $preserved_clause ) {
								$output .= 'use ' . $preserved_clause . ";\n";
							}
							$i = $j - 1;
							continue;
						}

						if ( $use_has_group && ( ! $this->flatten_namespaces || $keep_namespace ) ) {
							// Grouped use without flattening: expand members and map
							// project classes exactly like single imports.
							$rendered_clauses = array();
							foreach ( $this->expand_use_statement_clauses( $use_inner_raw ) as $expanded ) {
								if ( preg_match( '/^(function|const)\s+/i', $expanded ) ) {
									$rendered_clauses[] = $expanded;
									continue;
								}
								if ( preg_match( '/^\\\\?([a-zA-Z0-9_\\\\]+)(?:\s+as\s+([a-zA-Z0-9_]+))?$/i', $expanded, $gm ) ) {
									$group_target = ltrim( $gm[1], '\\' );
									if ( isset( $this->class_map[ $group_target ] ) ) {
										$group_mangled = $this->class_map[ $group_target ];
										$group_parts   = explode( '\\', $group_target );
										$group_short   = end( $group_parts );
										$group_alias   = isset( $gm[2] ) && $gm[2] !== '' ? $gm[2] : $group_short;
										$rendered_clauses[] = $group_mangled . ' as ' . $group_alias;
										continue;
									}
								}
								$rendered_clauses[] = $expanded;
							}
							foreach ( $rendered_clauses as $rendered_clause ) {
								$output .= 'use ' . $rendered_clause . ";\n";
							}
							$i = $j - 1;
							continue;
						}

						if ( $this->flatten_namespaces && ! $keep_namespace ) {
							$preserved_clauses = array();
							foreach ( $clauses as $clause ) {
								$is_func_or_const = false;
								foreach ( $clause as $ct ) {
									if ( is_array( $ct ) && ( $ct[0] === T_FUNCTION || $ct[0] === T_CONST ) ) {
										$is_func_or_const = true;
										break;
									}
								}
								if ( $is_func_or_const ) {
									$raw = '';
									foreach ( $clause as $ct ) {
										$raw .= is_array( $ct ) ? ( ( $ct[0] === T_WHITESPACE ) ? ' ' : $ct[1] ) : $ct;
									}
									$preserved_clauses[] = trim( $raw );
									continue;
								}

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

				// 1b. Inline HTML preserved byte-exact
				if ( $id === T_INLINE_HTML ) {
					$output .= $text;
					continue;
				}

				// 2. Comment Stripping with Token Boundary Preservation
				if ( $id === T_COMMENT || $id === T_DOC_COMMENT ) {
					if ( ! $this->strip_comments ) {
						$output .= $text;
						continue;
					}
					if ( $is_main_plugin_file && ! $seen_first_docblock && stripos( $text, 'Plugin Name:' ) !== false ) {
						$seen_first_docblock = true;
						$output .= "\n" . $text . "\n";
						continue;
					}

					$last_char = substr( $output, -1 );
					if ( $last_char !== false && $last_char !== '' && ! in_array( $last_char, array( " ", "\n", "\t", "\r" ), true ) ) {
						$next_idx = $i + 1;
						while ( $next_idx < $count && is_array( $tokens[ $next_idx ] ) && in_array( $tokens[ $next_idx ][0], array( T_COMMENT, T_DOC_COMMENT ), true ) ) {
							$next_idx++;
						}
						if ( $next_idx < $count ) {
							$next_tok = $tokens[ $next_idx ];
							$next_is_ws = is_array( $next_tok ) && $next_tok[0] === T_WHITESPACE;
							if ( ! $next_is_ws ) {
								$output .= ' ';
							}
						}
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
						$output .= ( $this->flatten_namespaces && ! empty( $current_namespace ) && ! $keep_namespace ) ? ( '\\' . $target ) : $target;
						continue;
					}
					if ( isset( $this->class_map[ $text ] ) ) {
						$target = $this->class_map[ $text ];
						$output .= ( $this->flatten_namespaces && ! empty( $current_namespace ) && ! $keep_namespace ) ? ( '\\' . $target ) : $target;
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
				if ( $id === T_STRING || ( defined( 'T_NAME_FULLY_QUALIFIED' ) && $id === T_NAME_FULLY_QUALIFIED ) ) {
					$clean_token_text = ltrim( $text, '\\' );
					if ( strtolower( $clean_token_text ) === 'compact' ) {
						$c_offset   = $token_offsets[ $i ];
						$c_decision = isset( $compact_decisions[ $c_offset ] ) ? $compact_decisions[ $c_offset ] : null;
						if ( $c_decision === 'retain' ) {
							$output .= $text;
							continue;
						} elseif ( is_array( $c_decision ) && $c_decision[0] === 'rewrite' ) {
							$compact = $this->try_rewrite_compact_call( $tokens, $i, $count );
							if ( $compact !== null ) {
								$output .= $compact['code'];
								$i = $compact['end'];
								continue;
							}
						} else {
							$output .= $text;
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
								$decl_name = ( strpos( $func_target, '\\' ) !== false ) ? substr( strrchr( $func_target, '\\' ), 1 ) : $func_target;
								$output   .= $decl_name;
								continue;
							}
						}
						if ( ! $is_declaration && isset( $file_use_map[ $text ] ) ) {
							if ( isset( $this->class_map[ $file_use_map[ $text ] ] ) ) {
								$target = $this->class_map[ $file_use_map[ $text ] ];
								if ( $this->flatten_namespaces && ! empty( $current_namespace ) && ! $keep_namespace ) {
									$output .= '\\' . $target;
								} elseif ( ! empty( $current_namespace ) && strpos( $target, '\\' ) !== false ) {
									// A bare qualified name inside a namespace block
									// resolves relative to it: shorten same-namespace
									// targets, anchor everything else globally.
									if ( strncmp( $target, $current_namespace . '\\', strlen( $current_namespace ) + 1 ) === 0 ) {
										$output .= substr( $target, strlen( $current_namespace ) + 1 );
									} else {
										$output .= '\\' . ltrim( $target, '\\' );
									}
								} else {
									$output .= $target;
								}
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
							if ( $this->flatten_namespaces && ! $keep_namespace ) {
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
						$member_prev = $this->prev_code_index( $tokens, $i );
						$is_member_name = $member_prev >= 0 && is_array( $tokens[ $member_prev ] ) && in_array(
							$tokens[ $member_prev ][0],
							array( T_OBJECT_OPERATOR, defined( 'T_NULLSAFE_OBJECT_OPERATOR' ) ? T_NULLSAFE_OBJECT_OPERATOR : -1, T_DOUBLE_COLON ),
							true
						);
						$is_fn_call = ! $is_declaration && ! $is_member_name && $this->occurrence_is_function_call( $tokens, $i, $count );
						if ( $is_fn_call ) {
							$func_target = $this->resolve_function_name( $text, $current_namespace, $file_use_func_map );
							if ( $func_target !== null ) {
								if ( ! empty( $current_namespace ) && ( ! $this->flatten_namespaces || $keep_namespace ) ) {
									if ( strncmp( $func_target, $current_namespace . '\\', strlen( $current_namespace ) + 1 ) === 0 ) {
										$output .= substr( $func_target, strlen( $current_namespace ) + 1 );
									} else {
										$output .= ( strpos( $func_target, '\\' ) !== false && substr( $func_target, 0, 1 ) !== '\\' ) ? ( '\\' . $func_target ) : $func_target;
									}
								} else {
									$output .= ( $this->flatten_namespaces && ! empty( $current_namespace ) && ! $keep_namespace && strpos( $func_target, '\\' ) === false ) ? $func_target : ( ( strpos( $func_target, '\\' ) !== false && substr( $func_target, 0, 1 ) !== '\\' ) ? ( '\\' . $func_target ) : $func_target );
								}
								continue;
							}
						}
						$mapped_class = $this->lookup_class_map( $text );
						if ( $mapped_class !== null && ! $is_fn_call && ! $is_member_name ) {
							$target = $mapped_class;
							$emit_global = $this->flatten_namespaces && ! empty( $current_namespace ) && ! $is_declaration && ! $keep_namespace;
							$output .= $emit_global ? ( '\\' . ltrim( $target, '\\' ) ) : $target;
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

					$is_callable_method_string = $this->is_array_callable_method_string( $tokens, $i );
					$is_callback_string = $is_callable_method_string || $this->is_callback_key_string( $tokens, $i ) || $this->is_callback_argument_string( $tokens, $i );
					$is_reflection = $this->is_reflection_or_instantiation_string( $tokens, $i );

					// array('Class', 'method'): the first element names the class and must be
					// remapped, otherwise the registered callback points at a class that no longer
					// exists (WordPress hook registrations use this form constantly).
					if ( isset( $this->class_map[ $norm_str ] ) && ( $is_reflection || $is_callable_method_string || $this->is_array_callable_class_string( $tokens, $i ) ) ) {
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

					if ( $this->is_array_callable_method_string( $tokens, $i ) && ! empty( $current_class_fqcn ) ) {
						$raw_str_lower = strtolower( $raw_str );
						if ( isset( $this->private_members['methods'][ $current_class_fqcn ][ $raw_str_lower ] ) && ! isset( $this->preserved_members[ $current_class_fqcn ]['methods'][ $raw_str_lower ] ) ) {
							$quote = $text[0];
							$output .= $quote . $this->private_members['methods'][ $current_class_fqcn ][ $raw_str_lower ] . $quote;
							continue;
						}
					}

					$output .= $text;
					continue;
				}

				// 7. Variable Mangling
				if ( $id === T_VARIABLE ) {
					$raw_var_name = substr( $text, 1 );
					if ( $in_function_header ) {
						$output .= $text;
						continue;
					}

					// Case A: Property declaration directly in class/trait body
					if ( $in_class && $class_brace_depth === 1 && ! $in_function_header ) {
						if ( ! empty( $current_class_fqcn ) && isset( $this->private_members['properties'][ $current_class_fqcn ][ $raw_var_name ] ) && ! isset( $this->preserved_members[ $current_class_fqcn ]['properties'][ $raw_var_name ] ) ) {
							$mangled = $this->private_members['properties'][ $current_class_fqcn ][ $raw_var_name ];
							$output .= '$' . $mangled;
							$renamed_symbols[] = array( 'type' => 'private_property', 'original' => $raw_var_name, 'mangled' => $mangled );
						} else {
							// Public, protected, or preserved property declaration: PRESERVE EXACTLY
							$output .= $text;
						}
						continue;
					}

					// Case B: Local variable, parameter, global variable, or closure capture
					$v_offset   = $token_offsets[ $i ];
					$v_decision = isset( $var_decisions[ $v_offset ] ) ? $var_decisions[ $v_offset ] : null;
					if ( $v_decision !== null ) {
						$action = is_array( $v_decision ) ? $v_decision['action'] : $v_decision;
						if ( $action === 'preserve' ) {
							$output .= $text;
						} else {
							$output .= '$_v_' . substr( hash( 'sha256', $this->seed . ':v:' . $text ), 0, 8 );
						}
						continue;
					}

					$scope_id = isset( $token_scopes[ $i ] ) ? $token_scopes[ $i ] : 0;
					$is_dynamic = ! empty( $dynamic_scopes[ $scope_id ] ) || ! empty( $dynamic_scopes[0] );
					// Without symbol mangling (clean / spaghetti-only modes) local
					// names must be retained verbatim per the capability model.
					if ( ! $this->mangle_symbols ||
					     in_array( $text, self::$reserved_vars, true ) ||
					     isset( $preserved_vars[ $text ] ) ||
					     isset( $this->project_global_vars[ $text ] ) ||
					     $is_view_file ||
					     $scope_id === 0 ||
					     $is_dynamic ) {
						$output .= $text;
					} else {
						$output .= '$_v_' . substr( hash( 'sha256', $this->seed . ':v:' . $text ), 0, 8 );
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
						$name_offset = isset( $token_offsets[ $next ] ) ? $token_offsets[ $next ] : null;
						$access = ( $name_offset !== null && isset( $this->accesses_by_offset[ $name_offset ] ) ) ? $this->accesses_by_offset[ $name_offset ] : null;
						$receiver_fqcn = null;
						if ( is_array( $access ) && ! empty( $access['resolved'] ) && ! empty( $access['receiver'] ) ) {
							$receiver_fqcn = $access['receiver'];
						} elseif ( $is_this && ! empty( $current_class_fqcn ) ) {
							$receiver_fqcn = $current_class_fqcn;
						}

						if ( $receiver_fqcn ) {
							$kind_key = $is_method_call ? 'methods' : 'properties';
							$lookup_name = $is_method_call ? strtolower( $accessed_name ) : $accessed_name;
							if ( isset( $this->private_members[ $kind_key ][ $receiver_fqcn ][ $lookup_name ] ) && ! isset( $this->preserved_members[ $receiver_fqcn ][ $kind_key ][ $lookup_name ] ) ) {
								$output .= $ws . $this->private_members[ $kind_key ][ $receiver_fqcn ][ $lookup_name ];
								$i = $next;
								continue;
							}
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
					$target_class = '';
					if ( $prev >= 0 && is_array( $tokens[ $prev ] ) ) {
						$prev_text = strtolower( $tokens[ $prev ][1] );
						if ( $prev_text === 'self' || $prev_text === 'static' ) {
							$target_class = $current_class_fqcn;
						} elseif ( $prev_text === 'parent' ) {
							$target_class = isset( $this->class_hierarchy[ $current_class_fqcn ]['parent'] ) ? $this->class_hierarchy[ $current_class_fqcn ]['parent'] : '';
						} else {
							$raw_c = ltrim( $tokens[ $prev ][1], '\\' );
							if ( isset( $file_use_map[ $raw_c ] ) ) {
								$target_class = $file_use_map[ $raw_c ];
							} elseif ( ! empty( $current_namespace ) && ( isset( $this->class_map[ $current_namespace . '\\' . $raw_c ] ) || isset( $this->private_members['constants'][ $current_namespace . '\\' . $raw_c ] ) || isset( $this->private_members['methods'][ $current_namespace . '\\' . $raw_c ] ) ) ) {
								$target_class = $current_namespace . '\\' . $raw_c;
							} else {
								$target_class = $raw_c;
							}
						}
					}

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
							$lookup_name = $is_method_call ? strtolower( $accessed_name ) : $accessed_name;

							if ( $is_method_call && ! empty( $target_class ) && isset( $this->private_members['methods'][ $target_class ][ $lookup_name ] ) && ! isset( $this->preserved_members[ $target_class ]['methods'][ $lookup_name ] ) ) {
								$output .= $ws . $this->private_members['methods'][ $target_class ][ $lookup_name ];
								$i = $next;
								continue;
							} elseif ( ! $is_method_call && $accessed_name !== 'class' && ! empty( $target_class ) && isset( $this->private_members['constants'][ $target_class ][ $accessed_name ] ) && ! isset( $this->preserved_members[ $target_class ]['constants'][ $accessed_name ] ) ) {
								$output .= $ws . $this->private_members['constants'][ $target_class ][ $accessed_name ];
								$i = $next;
								continue;
							}
						} elseif ( $tokens[ $next ][0] === T_VARIABLE ) {
							$raw_prop = substr( $tokens[ $next ][1], 1 );
							if ( ! empty( $target_class ) && isset( $this->private_members['properties'][ $target_class ][ $raw_prop ] ) && ! isset( $this->preserved_members[ $target_class ]['properties'][ $raw_prop ] ) ) {
								$output .= $ws . '$' . $this->private_members['properties'][ $target_class ][ $raw_prop ];
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
				$text_lower = strtolower( $text );
				if ( $id === T_STRING && $in_class && ! empty( $current_class_fqcn ) && isset( $this->private_members['methods'][ $current_class_fqcn ][ $text_lower ] ) && ! isset( $this->preserved_members[ $current_class_fqcn ]['methods'][ $text_lower ] ) ) {
					$prev = $i - 1;
					while ( $prev >= 0 && is_array( $tokens[ $prev ] ) && ( $tokens[ $prev ][0] === T_WHITESPACE || $tokens[ $prev ][0] === T_STATIC || $tokens[ $prev ][0] === T_FINAL || ( defined( 'T_ABSTRACT' ) && $tokens[ $prev ][0] === T_ABSTRACT ) ) ) {
						$prev--;
					}
					if ( $prev >= 0 && is_array( $tokens[ $prev ] ) && $tokens[ $prev ][0] === T_FUNCTION ) {
						$mangled = $this->private_members['methods'][ $current_class_fqcn ][ $text_lower ];
						$output .= $mangled;
						$renamed_symbols[] = array( 'type' => 'private_method', 'original' => $text, 'mangled' => $mangled );
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

		if ( ! empty( $declared_classes_in_file ) && $this->flatten_namespaces && ! $keep_namespace && $this->mangle_symbols ) {
			$alias_code = '';
			foreach ( $declared_classes_in_file as $fqcn => $info ) {
				$mangled = is_array( $info ) ? $info['mangled'] : $info;
				$type    = is_array( $info ) ? $info['type'] : T_CLASS;
				if ( $type === T_INTERFACE ) {
					$alias_code .= "if (interface_exists('" . addslashes( $mangled ) . "', false) && !interface_exists('" . addslashes( $fqcn ) . "', false)) { class_alias('" . addslashes( $mangled ) . "', '" . addslashes( $fqcn ) . "'); }\n";
				} elseif ( $type === T_TRAIT ) {
					$alias_code .= "if (trait_exists('" . addslashes( $mangled ) . "', false) && !trait_exists('" . addslashes( $fqcn ) . "', false)) { class_alias('" . addslashes( $mangled ) . "', '" . addslashes( $fqcn ) . "'); }\n";
				} elseif ( defined( 'T_ENUM' ) && $type === T_ENUM ) {
					$alias_code .= "if (function_exists('enum_exists') && enum_exists('" . addslashes( $mangled ) . "', false) && !enum_exists('" . addslashes( $fqcn ) . "', false)) { class_alias('" . addslashes( $mangled ) . "', '" . addslashes( $fqcn ) . "'); }\n";
				} else {
					$alias_code .= "if (class_exists('" . addslashes( $mangled ) . "', false) && !class_exists('" . addslashes( $fqcn ) . "', false)) { class_alias('" . addslashes( $mangled ) . "', '" . addslashes( $fqcn ) . "'); }\n";
				}
			}
			if ( $alias_code !== '' ) {
				if ( $retained_brace_namespace_emitted ) {
					$output .= "\nnamespace {\n" . $alias_code . "}\n";
				} else {
					$output .= "\n" . $alias_code;
				}
			}
		}



		return array(
			'code'     => $output,
			'manifest' => array(
				'file'               => $file_rel_path,
				'renamedSymbols'     => $renamed_symbols,
				'retainedNamespaces' => array_values( array_unique( $file_retained_namespaces ) ),
			),
		);
	}
}

function plan3_cli_bool_flags( $argv ) {
	$flatten = true;
	$mangle  = true;
	$strip   = true;
	foreach ( $argv as $arg ) {
		if ( ! is_string( $arg ) ) {
			continue;
		}
		if ( $arg === '--flatten=0' || $arg === '--no-flatten' ) {
			$flatten = false;
		} elseif ( $arg === '--flatten=1' ) {
			$flatten = true;
		} elseif ( $arg === '--mangle=0' || $arg === '--no-mangle' ) {
			$mangle = false;
		} elseif ( $arg === '--mangle=1' ) {
			$mangle = true;
		} elseif ( $arg === '--strip-comments=0' || $arg === '--no-strip-comments' ) {
			$strip = false;
		} elseif ( $arg === '--strip-comments=1' ) {
			$strip = true;
		}
	}
	return array( $flatten, $mangle, $strip );
}

if ( isset( $argv[0] ) && basename( $argv[0] ) === 'transformer.php' ) {
	if ( isset( $argv[1] ) && $argv[1] === '--batch' ) {
		$staging_dir = isset( $argv[2] ) ? $argv[2] : '';
		$map_file    = isset( $argv[3] ) ? $argv[3] : '';
		$seed        = isset( $argv[4] ) ? $argv[4] : 'wpdev-plan3-release';
		$main_file   = isset( $argv[5] ) ? $argv[5] : '';
		list( $flatten_namespaces, $mangle_symbols, $strip_comments ) = plan3_cli_bool_flags( $argv );

		if ( empty( $staging_dir ) || ! is_dir( $staging_dir ) ) {
			fwrite( STDERR, "Error: Staging directory not found: $staging_dir\n" );
			exit( 1 );
		}

		$transformer = new Plan3_Transformer( $seed, $flatten_namespaces, $mangle_symbols, $strip_comments );
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
			$transformer->flatten_namespaces = $flatten_namespaces;
			$transformer->mangle_symbols     = $mangle_symbols;
			$transformer->strip_comments     = $strip_comments;
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
		list( $flatten_namespaces, $mangle_symbols, $strip_comments ) = plan3_cli_bool_flags( $argv );

		if ( empty( $scan_dir ) || ! is_dir( $scan_dir ) ) {
			fwrite( STDERR, "Error: Scan directory not found: $scan_dir\n" );
			exit( 1 );
		}

		$transformer = new Plan3_Transformer( $seed, $flatten_namespaces, $mangle_symbols, $strip_comments );
		$transformer->scan_symbols_in_dir( $scan_dir );
		$payload = array(
			'classes'              => $transformer->class_map,
			'functions'            => $transformer->function_map,
			'constants'            => $transformer->constant_map,
			'kinds'                => $transformer->class_kinds,
			'private_members'      => $transformer->private_members,
			'preserved_members'    => $transformer->preserved_members,
			'class_hierarchy'      => $transformer->class_hierarchy,
			'project_global_vars'  => $transformer->project_global_vars,
			'classes_meta'         => $transformer->classes,
			'declarations'         => $transformer->declarations,
			'symbolPaths'          => $transformer->symbol_paths,
			'retained_namespaces'  => $transformer->retained_namespaces,
			'__flattenNamespaces'  => $transformer->flatten_namespaces,
			'__mangleSymbols'      => $transformer->mangle_symbols,
			'__stripComments'      => $transformer->strip_comments,
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

