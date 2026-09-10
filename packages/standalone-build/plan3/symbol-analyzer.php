<?php
/**
 * Plan 3 AST Symbol & Scope Analyzer (Powered by nikic/php-parser)
 *
 * Implements Method Mandate for Symbol/Scope Analysis (Task 3, 4, 6):
 * 1. Analyzes classes, traits, interfaces, enums and their hierarchies.
 * 2. Resolves cross-file trait composition and inheritance edges.
 * 3. Tracks member declarations (constants, properties, methods) with visibility.
 * 4. Resolves member accesses and detects unprovable receivers.
 * 5. Makes deterministic mangling decisions (keying by declaring FQCN + kind + name).
 * 6. Preserves members with unprovable receivers and records explicit reasons.
 */

declare( strict_types=1 );

use PhpParser\Node;
use PhpParser\NodeTraverser;
use PhpParser\NodeVisitorAbstract;
use PhpParser\NodeVisitor\NameResolver;
use PhpParser\ParserFactory;

class Plan3_Scope {
	public $id;
	public $type; // 'file', 'function', 'method', 'closure', 'arrow'
	public $parent;
	public $children = array();
	public $is_dynamic = false;
	public $dynamic_reasons = array();
	public $declared_vars = array(); // '$var' => true
	public $used_vars = array();     // '$var' => true
	public $captured_vars = array(); // '$var' => ['by_ref' => bool, 'offset' => int]
	public $preserved_vars = array(); // '$var' => true or '*' => true
	public $var_nodes = array();     // offset => '$var'
	public $compact_calls = array(); // offset => Node
	public $params = array();        // '$var' => true
	public $unset_vars = array();    // '$var' => true
	public $start_pos = 0;
	public $end_pos = 0;

	public function __construct( $id, $type, $parent = null, $start_pos = 0, $end_pos = 0 ) {
		$this->id        = $id;
		$this->type      = $type;
		$this->parent    = $parent;
		$this->start_pos = $start_pos;
		$this->end_pos   = $end_pos;
		if ( $parent !== null ) {
			$parent->children[] = $this;
		}
	}
}

class Plan3_Symbol_Analyzer {

	private $seed;
	public $classes = array();
	public $accesses = array();
	public $private_members = array(
		'methods'    => array(),
		'properties' => array(),
		'constants'  => array(),
	);
	public $preserved_members = array();
	public $class_hierarchy = array();

	public $project_global_vars = array();
	public $file_var_decisions = array();
	public $file_compact_decisions = array();
	public $serialized_classes = array();
	public $unsupported_dynamic_cases = array();

	public static $reserved_vars = array(
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

	public function __construct( $seed = 'wpdev-plan3-release' ) {
		$this->seed = (string) $seed;
	}

	/**
	 * Analyzes a PHP code string.
	 */
	public function analyze_code( $code, $file_path = 'main.php', $run_finalize = true ) {
		$this->parse_and_collect( (string) $code, (string) $file_path );
		if ( $run_finalize ) {
			$this->finalize();
		}
	}

	/**
	 * Analyzes multiple files or directory.
	 */
	public function analyze_directory( $dir ) {
		if ( ! is_string( $dir ) || ! is_dir( $dir ) ) {
			return;
		}
		$iterator = new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $dir, RecursiveDirectoryIterator::SKIP_DOTS ) );
		foreach ( $iterator as $file ) {
			if ( $file->isFile() && $file->getExtension() === 'php' ) {
				$path = $file->getPathname();
				if ( strpos( $path, '/vendor/' ) !== false || strpos( $path, '/vendor-prefixed/' ) !== false ) {
					continue;
				}
				$content = @file_get_contents( $path );
				if ( $content !== false ) {
					$this->parse_and_collect( $content, $path );
				}
			}
		}
		$this->finalize();
	}

	protected function parse_and_collect( $code, $file_path ) {
		if ( ! class_exists( ParserFactory::class ) ) {
			return;
		}

		try {
			$parser    = ( new ParserFactory() )->createForHostVersion();
			$traverser = new NodeTraverser();
			$traverser->addVisitor( new NameResolver() );

			$visitor = new class( $this, $file_path ) extends NodeVisitorAbstract {
				private $analyzer;
				private $file_path;
				private $class_stack  = array();
				private $method_stack = array();
				private $param_types_stack = array();
				private $file_scope;
				private $current_scope;
				private $next_scope_id = 0;
				private $all_file_scopes = array();

				protected function extract_compact_vars( $argNode, &$vars, &$all_resolvable ) {
					if ( $argNode instanceof Node\Scalar\String_ ) {
						$vars[] = '$' . $argNode->value;
					} elseif ( $argNode instanceof Node\Expr\Array_ ) {
						foreach ( $argNode->items as $item ) {
							if ( $item !== null && $item->value instanceof Node\Expr ) {
								$this->extract_compact_vars( $item->value, $vars, $all_resolvable );
							} else {
								$all_resolvable = false;
							}
						}
					} else {
						$all_resolvable = false;
					}
				}

				public function __construct( $analyzer, $file_path ) {
					$this->analyzer  = $analyzer;
					$this->file_path = $file_path;

					$norm_path = str_replace( '\\', '/', (string) $file_path );
					$is_view_file = ( strpos( $norm_path, 'views/' ) !== false || strpos( $norm_path, 'templates/' ) !== false || strpos( $norm_path, 'FrameworkClosure/views/' ) !== false );

					$this->file_scope = new Plan3_Scope( $this->next_scope_id++, 'file', null, 0, PHP_INT_MAX );
					if ( $is_view_file ) {
						$this->file_scope->is_dynamic = true;
						$this->file_scope->dynamic_reasons[] = 'view_template';
						$this->file_scope->preserved_vars['*'] = true;
					} else {
						// Treat file/top-level scope as non-manglable for variables
						$this->file_scope->preserved_vars['*'] = true;
					}
					$this->current_scope = $this->file_scope;
					$this->all_file_scopes[] = $this->file_scope;
				}

				public function enterNode( Node $node ) {
					if ( $node instanceof Node\Stmt\ClassLike ) {
						$fqcn = '';
						if ( isset( $node->namespacedName ) && $node->namespacedName instanceof Node\Name ) {
							$fqcn = $node->namespacedName->toString();
						} elseif ( isset( $node->name ) && $node->name instanceof Node\Identifier ) {
							$fqcn = $node->name->toString();
						} else {
							$fqcn = 'anonymous@' . spl_object_hash( $node );
						}

						$kind = 'class';
						if ( $node instanceof Node\Stmt\Trait_ ) {
							$kind = 'trait';
						} elseif ( $node instanceof Node\Stmt\Interface_ ) {
							$kind = 'interface';
						} elseif ( $node instanceof Node\Stmt\Enum_ ) {
							$kind = 'enum';
						}

						$parent = ( $node instanceof Node\Stmt\Class_ && $node->extends ) ? $node->extends->toString() : null;
						$traits     = array();
						$methods    = array();
						$properties = array();
						$constants  = array();

						if ( isset( $node->stmts ) && is_array( $node->stmts ) ) {
							foreach ( $node->stmts as $stmt ) {
								if ( $stmt instanceof Node\Stmt\TraitUse ) {
									foreach ( $stmt->traits as $t ) {
										$traits[] = $t->toString();
									}
									if ( ! empty( $stmt->adaptations ) ) {
										foreach ( $stmt->adaptations as $adaptation ) {
											if ( isset( $adaptation->method ) && $adaptation->method instanceof Node\Identifier ) {
												$ad_method = strtolower( $adaptation->method->toString() );
												$this->analyzer->preserved_members[ $fqcn ]['methods'][ $ad_method ] = 'trait_adaptation';
												foreach ( $stmt->traits as $t ) {
													$this->analyzer->preserved_members[ $t->toString() ]['methods'][ $ad_method ] = 'trait_adaptation';
												}
											}
										}
									}
								} elseif ( $stmt instanceof Node\Stmt\ClassMethod ) {
									$m_name = strtolower( $stmt->name->toString() );
									$vis    = $stmt->isPrivate() ? 'private' : ( $stmt->isProtected() ? 'protected' : 'public' );
									$methods[ $m_name ] = array(
										'visibility' => $vis,
										'is_static'  => $stmt->isStatic(),
										'declaring'  => $fqcn,
										'file'       => $this->file_path,
										'line'       => $stmt->getStartLine(),
									);
								} elseif ( $stmt instanceof Node\Stmt\Property ) {
									$vis = $stmt->isPrivate() ? 'private' : ( $stmt->isProtected() ? 'protected' : 'public' );
									foreach ( $stmt->props as $p ) {
										$properties[ $p->name->toString() ] = array(
											'visibility' => $vis,
											'is_static'  => $stmt->isStatic(),
											'declaring'  => $fqcn,
											'file'       => $this->file_path,
											'line'       => $p->getStartLine(),
										);
									}
								} elseif ( $stmt instanceof Node\Stmt\ClassConst ) {
									$vis = $stmt->isPrivate() ? 'private' : ( $stmt->isProtected() ? 'protected' : 'public' );
									foreach ( $stmt->consts as $c ) {
										$constants[ $c->name->toString() ] = array(
											'visibility' => $vis,
											'declaring'  => $fqcn,
											'file'       => $this->file_path,
											'line'       => $c->getStartLine(),
										);
									}
								}
							}
						}

						$this->analyzer->classes[ $fqcn ] = array(
							'fqcn'       => $fqcn,
							'kind'       => $kind,
							'parent'     => $parent,
							'traits'     => $traits,
							'methods'    => $methods,
							'properties' => $properties,
							'constants'  => $constants,
						);
						if ( isset( $methods['__sleep'] ) || isset( $methods['__wakeup'] ) || isset( $methods['__serialize'] ) || isset( $methods['__unserialize'] ) ) {
							$this->analyzer->serialized_classes[ $fqcn ] = true;
						}
						$this->class_stack[] = $fqcn;
					} elseif ( $node instanceof Node\Stmt\ClassMethod ) {
						$m_name = strtolower( $node->name->toString() );
						$this->method_stack[] = $m_name;
					}

					// Param types stack & Scope hierarchy
					if ( $node instanceof Node\Stmt\Function_ || $node instanceof Node\Stmt\ClassMethod || $node instanceof Node\Expr\Closure || $node instanceof Node\Expr\ArrowFunction ) {
						$types = array();
						foreach ( $node->params as $param ) {
							if ( $param->type instanceof Node\Name ) {
								$p_var = ( $param->var instanceof Node\Expr\Variable && is_string( $param->var->name ) ) ? $param->var->name : '';
								if ( ! empty( $p_var ) ) {
									$types[ $p_var ] = $param->type->toString();
								}
							}
						}
						$this->param_types_stack[] = $types;
					}

					if ( $node instanceof Node\Expr\Assign ) {
						if ( $node->var instanceof Node\Expr\Variable && is_string( $node->var->name ) ) {
							$top = count( $this->param_types_stack ) - 1;
							if ( $top >= 0 && isset( $this->param_types_stack[ $top ][ $node->var->name ] ) ) {
								unset( $this->param_types_stack[ $top ][ $node->var->name ] );
							}
						}
					}

					if ( $node instanceof Node\Stmt\Function_ ) {
						$scope = new Plan3_Scope( $this->next_scope_id++, 'function', $this->current_scope, $node->getStartFilePos(), $node->getEndFilePos() );
						foreach ( $node->params as $param ) {
							if ( $param->var instanceof Node\Expr\Variable && is_string( $param->var->name ) ) {
								$p_name = '$' . $param->var->name;
								$scope->params[ $p_name ] = true;
								$scope->declared_vars[ $p_name ] = true;
								$scope->preserved_vars[ $p_name ] = true;
							}
						}
						$this->current_scope = $scope;
						$this->all_file_scopes[] = $scope;
					} elseif ( $node instanceof Node\Stmt\ClassMethod ) {
						$scope = new Plan3_Scope( $this->next_scope_id++, 'method', $this->current_scope, $node->getStartFilePos(), $node->getEndFilePos() );
						foreach ( $node->params as $param ) {
							if ( $param->var instanceof Node\Expr\Variable && is_string( $param->var->name ) ) {
								$p_name = '$' . $param->var->name;
								$scope->params[ $p_name ] = true;
								$scope->declared_vars[ $p_name ] = true;
								$scope->preserved_vars[ $p_name ] = true;
							}
						}
						$this->current_scope = $scope;
						$this->all_file_scopes[] = $scope;
					} elseif ( $node instanceof Node\Expr\Closure ) {
						$scope = new Plan3_Scope( $this->next_scope_id++, 'closure', $this->current_scope, $node->getStartFilePos(), $node->getEndFilePos() );
						foreach ( $node->params as $param ) {
							if ( $param->var instanceof Node\Expr\Variable && is_string( $param->var->name ) ) {
								$p_name = '$' . $param->var->name;
								$scope->params[ $p_name ] = true;
								$scope->declared_vars[ $p_name ] = true;
								$scope->preserved_vars[ $p_name ] = true;
							}
						}
						foreach ( $node->uses as $use ) {
							if ( $use->var instanceof Node\Expr\Variable && is_string( $use->var->name ) ) {
								$v_name = '$' . $use->var->name;
								$scope->captured_vars[ $v_name ] = array(
									'by_ref' => (bool) $use->byRef,
									'offset' => $use->var->getStartFilePos(),
								);
								$scope->var_nodes[ $use->var->getStartFilePos() ] = $v_name;
							}
						}
						$this->current_scope = $scope;
						$this->all_file_scopes[] = $scope;
					} elseif ( $node instanceof Node\Expr\ArrowFunction ) {
						$scope = new Plan3_Scope( $this->next_scope_id++, 'arrow', $this->current_scope, $node->getStartFilePos(), $node->getEndFilePos() );
						foreach ( $node->params as $param ) {
							if ( $param->var instanceof Node\Expr\Variable && is_string( $param->var->name ) ) {
								$p_name = '$' . $param->var->name;
								$scope->params[ $p_name ] = true;
								$scope->declared_vars[ $p_name ] = true;
								$scope->preserved_vars[ $p_name ] = true;
							}
						}
						$this->current_scope = $scope;
						$this->all_file_scopes[] = $scope;
					}

					if ( $node instanceof Node\Stmt\Unset_ ) {
						foreach ( $node->vars as $u_var ) {
							if ( $u_var instanceof Node\Expr\Variable && is_string( $u_var->name ) ) {
								$this->current_scope->unset_vars[ '$' . $u_var->name ] = true;
							}
						}
					}

					// Dynamic Scope Triggers
					if ( $node instanceof Node\Expr\FuncCall && $node->name instanceof Node\Name ) {
						$fn_name = $node->name->toLowerString();
						if ( $fn_name === 'extract' ) {
							$this->current_scope->is_dynamic = true;
							$this->current_scope->dynamic_reasons[] = 'extract';
						} elseif ( $fn_name === 'get_defined_vars' ) {
							$this->current_scope->is_dynamic = true;
							$this->current_scope->dynamic_reasons[] = 'get_defined_vars';
						} elseif ( $fn_name === 'compact' ) {
							$this->current_scope->compact_calls[ $node->getStartFilePos() ] = $node;
						} elseif ( ( $fn_name === 'serialize' || $fn_name === 'unserialize' ) && ! empty( $node->args ) ) {
							$arg0 = $node->args[0] instanceof Node\Arg ? $node->args[0]->value : $node->args[0];
							if ( $arg0 instanceof Node\Expr\New_ && $arg0->class instanceof Node\Name ) {
								$ser_class = $arg0->class->toString();
								$this->analyzer->serialized_classes[ $ser_class ] = true;
							}
						}
					}

					if ( $node instanceof Node\Expr\Include_ ) {
						$this->current_scope->is_dynamic = true;
						$this->current_scope->dynamic_reasons[] = 'include';
					}

					if ( $node instanceof Node\Stmt\Global_ ) {
						foreach ( $node->vars as $var ) {
							if ( $var instanceof Node\Expr\Variable && is_string( $var->name ) ) {
								$v_name = '$' . $var->name;
								$this->analyzer->project_global_vars[ $v_name ] = true;
								$this->current_scope->preserved_vars[ $v_name ] = true;
								$this->current_scope->var_nodes[ $var->getStartFilePos() ] = $v_name;
							}
						}
					}

					if ( $node instanceof Node\Expr\Variable ) {
						if ( ! is_string( $node->name ) ) {
							$this->current_scope->is_dynamic = true;
							$this->current_scope->dynamic_reasons[] = 'variable_variable';
							$this->analyzer->unsupported_dynamic_cases[] = array(
								'file'   => $this->file_path,
								'line'   => $node->getStartLine(),
								'reason' => 'variable_variable: dynamic variable evaluation',
							);
						} else {
							$v_name = '$' . $node->name;
							if ( $node->name === 'GLOBALS' ) {
								$this->current_scope->is_dynamic = true;
								$this->current_scope->dynamic_reasons[] = 'GLOBALS';
							}
							$this->current_scope->var_nodes[ $node->getStartFilePos() ] = $v_name;
							$this->current_scope->used_vars[ $v_name ] = true;
						}
					}

					if ( $node instanceof Node\Expr\Assign && $node->var instanceof Node\Expr\Variable && is_string( $node->var->name ) ) {
						$this->current_scope->declared_vars[ '$' . $node->var->name ] = true;
					}

					$current_class  = ! empty( $this->class_stack ) ? end( $this->class_stack ) : null;
					$current_method = ! empty( $this->method_stack ) ? end( $this->method_stack ) : null;

					if ( $current_class !== null ) {
						$curr_param_types = ! empty( $this->param_types_stack ) ? end( $this->param_types_stack ) : array();

						if ( $node instanceof Node\Expr\MethodCall || $node instanceof Node\Expr\NullsafeMethodCall ) {
							$is_this = ( $node->var instanceof Node\Expr\Variable && $node->var->name === 'this' );
							if ( $node->name instanceof Node\Identifier ) {
								$name    = strtolower( $node->name->toString() );
								$receiver = null;
								if ( $is_this ) {
									$receiver = $current_class;
								} elseif ( $node->var instanceof Node\Expr\Variable && is_string( $node->var->name ) && isset( $curr_param_types[ $node->var->name ] ) ) {
									$receiver = $curr_param_types[ $node->var->name ];
								} elseif ( $node->var instanceof Node\Expr\New_ && $node->var->class instanceof Node\Name ) {
									$receiver = $node->var->class->toString();
								}
								$this->analyzer->accesses[] = array(
									'kind'         => 'method',
									'name'         => $name,
									'resolved'     => ( $receiver !== null ),
									'receiver'     => $receiver,
									'callerClass'  => $current_class,
									'callerMethod' => $current_method,
									'file'         => $this->file_path,
									'line'         => $node->getStartLine(),
									'offset'       => $node->name->getStartFilePos(),
								);
							} else {
								$this->analyzer->accesses[] = array(
									'kind'         => 'dynamic_method',
									'name'         => '*',
									'resolved'     => false,
									'receiver'     => $is_this ? $current_class : null,
									'callerClass'  => $current_class,
									'callerMethod' => $current_method,
									'file'         => $this->file_path,
									'line'         => $node->getStartLine(),
									'offset'       => $node->getStartFilePos(),
								);
							}
						} elseif ( $node instanceof Node\Expr\PropertyFetch || $node instanceof Node\Expr\NullsafePropertyFetch ) {
							$is_this = ( $node->var instanceof Node\Expr\Variable && $node->var->name === 'this' );
							if ( $node->name instanceof Node\Identifier ) {
								$name    = $node->name->toString();
								$receiver = null;
								if ( $is_this ) {
									$receiver = $current_class;
								} elseif ( $node->var instanceof Node\Expr\Variable && is_string( $node->var->name ) && isset( $curr_param_types[ $node->var->name ] ) ) {
									$receiver = $curr_param_types[ $node->var->name ];
								}
								$this->analyzer->accesses[] = array(
									'kind'         => 'property',
									'name'         => $name,
									'resolved'     => ( $receiver !== null ),
									'receiver'     => $receiver,
									'callerClass'  => $current_class,
									'callerMethod' => $current_method,
									'file'         => $this->file_path,
									'line'         => $node->getStartLine(),
									'offset'       => $node->name->getStartFilePos(),
								);
							} else {
								$this->analyzer->accesses[] = array(
									'kind'         => 'dynamic_property',
									'name'         => '*',
									'resolved'     => false,
									'receiver'     => $is_this ? $current_class : null,
									'callerClass'  => $current_class,
									'callerMethod' => $current_method,
									'file'         => $this->file_path,
									'line'         => $node->getStartLine(),
									'offset'       => $node->getStartFilePos(),
								);
							}
						} elseif ( $node instanceof Node\Expr\ArrayItem && $node->key instanceof Node\Scalar\String_ && in_array( $node->key->value, array( 'callback', 'sanitize_callback', 'render_callback' ), true ) ) {
							if ( $node->value instanceof Node\Expr\Array_ && count( $node->value->items ) === 2 ) {
								$item0 = isset( $node->value->items[0] ) && $node->value->items[0] ? $node->value->items[0]->value : null;
								$item1 = isset( $node->value->items[1] ) && $node->value->items[1] ? $node->value->items[1]->value : null;
								if ( $item0 instanceof Node\Expr\Variable && $item0->name === 'this' && $item1 instanceof Node\Scalar\String_ ) {
									$this->analyzer->accesses[] = array(
										'kind'         => 'method',
										'name'         => strtolower( $item1->value ),
										'resolved'     => true,
										'receiver'     => $current_class,
										'callerClass'  => $current_class,
										'callerMethod' => $current_method,
										'file'         => $this->file_path,
										'line'         => $node->value->getStartLine(),
										'offset'       => $item1->getStartFilePos(),
									);
								}
							}
						} elseif ( $node instanceof Node\Expr\StaticCall && $node->name instanceof Node\Identifier ) {
							$name      = strtolower( $node->name->toString() );
							$class_ref = $node->class instanceof Node\Name ? $node->class->toString() : null;
							$receiver  = ( $class_ref === 'self' || $class_ref === 'static' ) ? $current_class : $class_ref;
							$this->analyzer->accesses[] = array(
								'kind'         => 'method',
								'name'         => $name,
								'resolved'     => ( $receiver !== null ),
								'receiver'     => $receiver,
								'callerClass'  => $current_class,
								'callerMethod' => $current_method,
								'file'         => $this->file_path,
								'line'         => $node->getStartLine(),
								'offset'       => $node->name->getStartFilePos(),
							);
						} elseif ( $node instanceof Node\Expr\StaticPropertyFetch && $node->name instanceof Node\VarLikeIdentifier ) {
							$name      = $node->name->toString();
							$class_ref = $node->class instanceof Node\Name ? $node->class->toString() : null;
							$receiver  = ( $class_ref === 'self' || $class_ref === 'static' ) ? $current_class : $class_ref;
							$this->analyzer->accesses[] = array(
								'kind'         => 'property',
								'name'         => $name,
								'resolved'     => ( $receiver !== null ),
								'receiver'     => $receiver,
								'callerClass'  => $current_class,
								'callerMethod' => $current_method,
								'file'         => $this->file_path,
								'line'         => $node->getStartLine(),
								'offset'       => $node->name->getStartFilePos(),
							);
						} elseif ( $node instanceof Node\Expr\ClassConstFetch && $node->name instanceof Node\Identifier ) {
							$name      = $node->name->toString();
							$class_ref = $node->class instanceof Node\Name ? $node->class->toString() : null;
							$receiver  = ( $class_ref === 'self' || $class_ref === 'static' ) ? $current_class : $class_ref;
							$this->analyzer->accesses[] = array(
								'kind'         => 'constant',
								'name'         => $name,
								'resolved'     => ( $receiver !== null ),
								'receiver'     => $receiver,
								'callerClass'  => $current_class,
								'callerMethod' => $current_method,
								'file'         => $this->file_path,
								'line'         => $node->getStartLine(),
								'offset'       => $node->name->getStartFilePos(),
							);
						}
					}
				}

				public function leaveNode( Node $node ) {
					if ( $node instanceof Node\Stmt\ClassLike ) {
						array_pop( $this->class_stack );
					} elseif ( $node instanceof Node\Stmt\ClassMethod ) {
						array_pop( $this->method_stack );
					}

					if ( $node instanceof Node\Stmt\Function_ || $node instanceof Node\Stmt\ClassMethod || $node instanceof Node\Expr\Closure || $node instanceof Node\Expr\ArrowFunction ) {
						if ( ! empty( $this->param_types_stack ) ) {
							array_pop( $this->param_types_stack );
						}
						if ( $this->current_scope->parent !== null ) {
							$this->current_scope = $this->current_scope->parent;
						}
					}
				}

				public function process_scope_decisions() {
					// 1. Initial compact evaluation: determine which compact calls can be safely rewritten
					foreach ( $this->all_file_scopes as $scope ) {
						foreach ( $scope->compact_calls as $offset => $callNode ) {
							$can_rewrite = true;
							if ( $scope->is_dynamic || $scope->type === 'file' || empty( $callNode->args ) ) {
								$can_rewrite = false;
							}
							$args = array();
							if ( $can_rewrite ) {
								foreach ( $callNode->args as $arg ) {
									$val = $arg instanceof Node\Arg ? $arg->value : $arg;
									if ( $val instanceof Node\Scalar\String_ ) {
										$arg_name = '$' . $val->value;
										if ( ! isset( $scope->declared_vars[ $arg_name ] )
											|| isset( $scope->params[ $arg_name ] )
											|| isset( $scope->unset_vars[ $arg_name ] )
											|| isset( $scope->preserved_vars[ $arg_name ] )
											|| isset( $this->analyzer->project_global_vars[ $arg_name ] )
											|| in_array( $arg_name, Plan3_Symbol_Analyzer::$reserved_vars, true )
										) {
											$can_rewrite = false;
											break;
										}
										$args[] = $val->value;
									} else {
										$can_rewrite = false;
										break;
									}
								}
							}

							if ( $can_rewrite && ! empty( $args ) ) {
								$this->analyzer->file_compact_decisions[ $this->file_path ][ $offset ] = array( 'rewrite', $args );
							} else {
								$this->analyzer->file_compact_decisions[ $this->file_path ][ $offset ] = 'retain';
								$vars = array();
								$all_resolvable = true;
								foreach ( $callNode->args as $arg ) {
									$val = $arg instanceof Node\Arg ? $arg->value : $arg;
									$this->extract_compact_vars( $val, $vars, $all_resolvable );
								}
								if ( ! $all_resolvable ) {
									$scope->is_dynamic = true;
									$scope->dynamic_reasons[] = 'compact_unresolved';
								} else {
									foreach ( $vars as $v_name ) {
										$scope->preserved_vars[ $v_name ] = true;
									}
								}
							}
						}
					}

					// 2. Bidirectional propagation loop
					$changed = true;
					$passes  = 0;
					while ( $changed && $passes < 20 ) {
						$changed = false;
						$passes++;

						foreach ( $this->all_file_scopes as $scope ) {
							if ( $scope->is_dynamic && ! isset( $scope->preserved_vars['*'] ) ) {
								$scope->preserved_vars['*'] = true;
								$changed = true;
							}

							foreach ( $scope->children as $child ) {
								if ( $child->is_dynamic && ! isset( $child->preserved_vars['*'] ) ) {
									$child->preserved_vars['*'] = true;
									$changed = true;
								}

								// 1. Downward propagation from parent scope to child
								if ( $child->type === 'closure' ) {
									if ( isset( $scope->preserved_vars['*'] ) ) {
										foreach ( $child->captured_vars as $c_var => $meta ) {
											if ( ! isset( $child->preserved_vars[ $c_var ] ) ) {
												$child->preserved_vars[ $c_var ] = true;
												$changed = true;
											}
										}
									} else {
										foreach ( $child->captured_vars as $c_var => $meta ) {
											if ( isset( $scope->preserved_vars[ $c_var ] ) && ! isset( $child->preserved_vars[ $c_var ] ) ) {
												$child->preserved_vars[ $c_var ] = true;
												$changed = true;
											}
										}
									}
								} elseif ( $child->type === 'arrow' ) {
									if ( isset( $scope->preserved_vars['*'] ) ) {
										foreach ( $child->used_vars as $u_var => $_ ) {
											if ( ! isset( $child->declared_vars[ $u_var ] ) && ! isset( $child->preserved_vars[ $u_var ] ) ) {
												$child->preserved_vars[ $u_var ] = true;
												$changed = true;
											}
										}
									} else {
										foreach ( $child->used_vars as $u_var => $_ ) {
											if ( isset( $scope->preserved_vars[ $u_var ] ) && ! isset( $child->declared_vars[ $u_var ] ) && ! isset( $child->preserved_vars[ $u_var ] ) ) {
												$child->preserved_vars[ $u_var ] = true;
												$changed = true;
											}
										}
									}
								}

								// 2. Upward propagation from child closure/arrow to parent scope
								if ( $child->type === 'closure' ) {
									if ( isset( $child->preserved_vars['*'] ) ) {
										foreach ( $child->captured_vars as $c_var => $meta ) {
											if ( ! isset( $scope->preserved_vars[ $c_var ] ) ) {
												$scope->preserved_vars[ $c_var ] = true;
												$changed = true;
											}
										}
									} else {
										foreach ( $child->captured_vars as $c_var => $meta ) {
											if ( isset( $child->preserved_vars[ $c_var ] ) && ! isset( $scope->preserved_vars[ $c_var ] ) ) {
												$scope->preserved_vars[ $c_var ] = true;
												$changed = true;
											}
										}
									}
								} elseif ( $child->type === 'arrow' ) {
									if ( isset( $child->preserved_vars['*'] ) ) {
										foreach ( $child->used_vars as $u_var => $_ ) {
											if ( ! isset( $child->declared_vars[ $u_var ] ) && ! isset( $scope->preserved_vars[ $u_var ] ) ) {
												$scope->preserved_vars[ $u_var ] = true;
												$changed = true;
											}
										}
									} else {
										foreach ( $child->used_vars as $u_var => $_ ) {
											if ( isset( $child->preserved_vars[ $u_var ] ) && ! isset( $child->declared_vars[ $u_var ] ) && ! isset( $scope->preserved_vars[ $u_var ] ) ) {
												$scope->preserved_vars[ $u_var ] = true;
												$changed = true;
											}
										}
									}
								}
							}
						}
					}

					// 3. Post-propagation check: ensure no rewritten compact uses a preserved variable
					foreach ( $this->all_file_scopes as $scope ) {
						foreach ( $scope->compact_calls as $offset => $callNode ) {
							$dec = isset( $this->analyzer->file_compact_decisions[ $this->file_path ][ $offset ] ) ? $this->analyzer->file_compact_decisions[ $this->file_path ][ $offset ] : 'retain';
							if ( is_array( $dec ) && $dec[0] === 'rewrite' ) {
								foreach ( $dec[1] as $a_name ) {
									if ( isset( $scope->preserved_vars[ '$' . $a_name ] ) || isset( $scope->preserved_vars['*'] ) ) {
										$this->analyzer->file_compact_decisions[ $this->file_path ][ $offset ] = 'retain';
										foreach ( $dec[1] as $preserved_a ) {
											$scope->preserved_vars[ '$' . $preserved_a ] = true;
										}
										break;
									}
								}
							}
						}

						foreach ( $scope->var_nodes as $offset => $v_name ) {
							$must_preserve = false;
							if ( isset( $scope->preserved_vars['*'] ) || isset( $scope->preserved_vars[ $v_name ] ) ) {
								$must_preserve = true;
							} elseif ( isset( $this->analyzer->project_global_vars[ $v_name ] ) ) {
								$must_preserve = true;
							} elseif ( in_array( $v_name, Plan3_Symbol_Analyzer::$reserved_vars, true ) ) {
								$must_preserve = true;
							}

							$this->analyzer->file_var_decisions[ $this->file_path ][ $offset ] = array(
								'var'    => $v_name,
								'action' => $must_preserve ? 'preserve' : 'mangle',
							);
						}
					}
				}
			};

			$traverser->addVisitor( $visitor );
			$stmts = $parser->parse( $code );
			if ( is_array( $stmts ) ) {
				$traverser->traverse( $stmts );
				$visitor->process_scope_decisions();
			}
		} catch ( Throwable $e ) {
			// Fail closed or preserve if AST cannot be parsed
			error_log( "Plan3_Symbol_Analyzer parse notice: " . $e->getMessage() );
		}
	}

	public function finalize() {
		// 1. Resolve Traits (Transitive Composition)
		$changed = true;
		$passes = 0;
		while ( $changed && $passes < 10 ) {
			$changed = false;
			$passes++;
			foreach ( $this->classes as $c_name => &$class ) {
				$new_traits = array();
				foreach ( $class['traits'] as $t_name ) {
					if ( isset( $this->classes[ $t_name ] ) ) {
						$trait = $this->classes[ $t_name ];
						foreach ( $trait['traits'] as $sub_t ) {
							if ( ! in_array( $sub_t, $class['traits'], true ) && ! in_array( $sub_t, $new_traits, true ) ) {
								$new_traits[] = $sub_t;
								$changed = true;
							}
						}
						foreach ( $trait['methods'] as $m_name => $m_meta ) {
							if ( ! isset( $class['methods'][ $m_name ] ) ) {
								$class['methods'][ $m_name ] = $m_meta;
								$changed = true;
							}
						}
						foreach ( $trait['properties'] as $p_name => $p_meta ) {
							if ( ! isset( $class['properties'][ $p_name ] ) ) {
								$class['properties'][ $p_name ] = $p_meta;
								$changed = true;
							}
						}
						foreach ( $trait['constants'] as $k_name => $k_meta ) {
							if ( ! isset( $class['constants'][ $k_name ] ) ) {
								$class['constants'][ $k_name ] = $k_meta;
								$changed = true;
							}
						}
					}
				}
				if ( ! empty( $new_traits ) ) {
					$class['traits'] = array_unique( array_merge( $class['traits'], $new_traits ) );
				}
			}
			unset( $class );
		}

		// 2. Build class hierarchy metadata
		foreach ( $this->classes as $c_name => $class ) {
			$this->class_hierarchy[ $c_name ] = array(
				'kind'   => $class['kind'],
				'parent' => $class['parent'],
				'traits' => $class['traits'],
			);
		}

		// 3. Find unresolved accesses (unprovable receiver) and dynamic calls
		$unresolved         = array();
		$dynamic_methods    = array();
		$dynamic_properties = array();
		foreach ( $this->accesses as $acc ) {
			if ( $acc['kind'] === 'dynamic_method' ) {
				if ( ! empty( $acc['receiver'] ) ) {
					$dynamic_methods[ $acc['receiver'] ] = true;
				} elseif ( ! empty( $acc['callerClass'] ) ) {
					$dynamic_methods[ $acc['callerClass'] ] = true;
				}
			} elseif ( $acc['kind'] === 'dynamic_property' ) {
				if ( ! empty( $acc['receiver'] ) ) {
					$dynamic_properties[ $acc['receiver'] ] = true;
				} elseif ( ! empty( $acc['callerClass'] ) ) {
					$dynamic_properties[ $acc['callerClass'] ] = true;
				}
			} elseif ( ! $acc['resolved'] ) {
				$caller = $acc['callerClass'];
				$kind   = $acc['kind'];
				$name   = $acc['name'];
				$unresolved[ $caller ][ $kind ][ $name ] = "unresolved_receiver: \$expr->{$name} in {$caller}::{$acc['callerMethod']}";
			}
		}

		// 4. Initial preservation from dynamic accesses, serialized classes, and unresolved callers
		foreach ( $dynamic_methods as $c_name => $_ ) {
			if ( isset( $this->classes[ $c_name ] ) ) {
				foreach ( $this->classes[ $c_name ]['methods'] as $m_name => $meta ) {
					$this->preserved_members[ $c_name ]['methods'][ $m_name ] = 'dynamic_method';
					$declaring = $meta['declaring'];
					if ( $declaring !== $c_name ) {
						$this->preserved_members[ $declaring ]['methods'][ $m_name ] = 'dynamic_method';
					}
				}
			}
		}

		foreach ( $dynamic_properties as $c_name => $_ ) {
			if ( isset( $this->classes[ $c_name ] ) ) {
				foreach ( $this->classes[ $c_name ]['properties'] as $p_name => $meta ) {
					$this->preserved_members[ $c_name ]['properties'][ $p_name ] = 'dynamic_property';
					$declaring = $meta['declaring'];
					if ( $declaring !== $c_name ) {
						$this->preserved_members[ $declaring ]['properties'][ $p_name ] = 'dynamic_property';
					}
				}
			}
		}

		foreach ( $this->serialized_classes as $ser_class => $_ ) {
			if ( isset( $this->classes[ $ser_class ] ) ) {
				foreach ( $this->classes[ $ser_class ]['properties'] as $p_name => $meta ) {
					$this->preserved_members[ $ser_class ]['properties'][ $p_name ] = 'serialized_class';
					$declaring = $meta['declaring'];
					if ( $declaring !== $ser_class ) {
						$this->preserved_members[ $declaring ]['properties'][ $p_name ] = 'serialized_class';
					}
				}
			}
		}

		foreach ( $this->classes as $c_name => $class ) {
			foreach ( $class['methods'] as $m_name => $meta ) {
				if ( $meta['visibility'] === 'private' ) {
					if ( in_array( $m_name, self::$magic_methods, true ) ) {
						$this->preserved_members[ $c_name ]['methods'][ $m_name ] = 'magic_method';
						$declaring = $meta['declaring'];
						if ( $declaring !== $c_name ) {
							$this->preserved_members[ $declaring ]['methods'][ $m_name ] = 'magic_method';
						}
					} elseif ( isset( $unresolved[ $c_name ]['method'][ $m_name ] ) ) {
						$reason = $unresolved[ $c_name ]['method'][ $m_name ];
						$this->preserved_members[ $c_name ]['methods'][ $m_name ] = $reason;
						$declaring = $meta['declaring'];
						if ( $declaring !== $c_name ) {
							$this->preserved_members[ $declaring ]['methods'][ $m_name ] = $reason;
						}
					}
				}
			}
			foreach ( $class['properties'] as $p_name => $meta ) {
				if ( $meta['visibility'] === 'private' && isset( $unresolved[ $c_name ]['property'][ $p_name ] ) ) {
					$reason = $unresolved[ $c_name ]['property'][ $p_name ];
					$this->preserved_members[ $c_name ]['properties'][ $p_name ] = $reason;
					$declaring = $meta['declaring'];
					if ( $declaring !== $c_name ) {
						$this->preserved_members[ $declaring ]['properties'][ $p_name ] = $reason;
					}
				}
			}
			foreach ( $class['constants'] as $k_name => $meta ) {
				if ( $meta['visibility'] === 'private' && isset( $unresolved[ $c_name ]['constant'][ $k_name ] ) ) {
					$reason = $unresolved[ $c_name ]['constant'][ $k_name ];
					$this->preserved_members[ $c_name ]['constants'][ $k_name ] = $reason;
					$declaring = $meta['declaring'];
					if ( $declaring !== $c_name ) {
						$this->preserved_members[ $declaring ]['constants'][ $k_name ] = $reason;
					}
				}
			}
		}

		// 5. Trait preservation fixed-point loop across all classes and traits
		$t_changed = true;
		$t_passes  = 0;
		while ( $t_changed && $t_passes < 10 ) {
			$t_changed = false;
			$t_passes++;
			foreach ( $this->classes as $c_name => $class ) {
				foreach ( $class['traits'] as $t_name ) {
					if ( ! isset( $this->classes[ $t_name ] ) ) {
						continue;
					}
					$trait = $this->classes[ $t_name ];
					foreach ( array( 'methods', 'properties', 'constants' ) as $kind ) {
						if ( isset( $this->preserved_members[ $c_name ][ $kind ] ) ) {
							foreach ( $this->preserved_members[ $c_name ][ $kind ] as $mem => $reason ) {
								if ( isset( $trait[ $kind ][ $mem ] ) && ! isset( $this->preserved_members[ $t_name ][ $kind ][ $mem ] ) ) {
									$this->preserved_members[ $t_name ][ $kind ][ $mem ] = $reason;
									$t_changed = true;
								}
							}
						}
						if ( isset( $this->preserved_members[ $t_name ][ $kind ] ) ) {
							foreach ( $this->preserved_members[ $t_name ][ $kind ] as $mem => $reason ) {
								if ( isset( $class[ $kind ][ $mem ] ) && ! isset( $this->preserved_members[ $c_name ][ $kind ][ $mem ] ) ) {
									$this->preserved_members[ $c_name ][ $kind ][ $mem ] = $reason;
									$t_changed = true;
								}
							}
						}
					}
				}
			}
		}

		// 6. Generate mangled private members
		foreach ( $this->classes as $c_name => $class ) {
			foreach ( $class['methods'] as $m_name => $meta ) {
				if ( $meta['visibility'] === 'private' && ! isset( $this->preserved_members[ $c_name ]['methods'][ $m_name ] ) ) {
					$declaring = $meta['declaring'];
					$mangled   = '_m_' . substr( hash( 'sha256', $this->seed . ':m:' . $declaring . '::' . $m_name ), 0, 8 );
					$this->private_members['methods'][ $c_name ][ $m_name ] = $mangled;
					if ( $declaring !== $c_name ) {
						$this->private_members['methods'][ $declaring ][ $m_name ] = $mangled;
					}
				}
			}
			foreach ( $class['properties'] as $p_name => $meta ) {
				if ( $meta['visibility'] === 'private' && ! isset( $this->preserved_members[ $c_name ]['properties'][ $p_name ] ) ) {
					$declaring = $meta['declaring'];
					$mangled   = '_p_' . substr( hash( 'sha256', $this->seed . ':p:' . $declaring . '::' . $p_name ), 0, 8 );
					$this->private_members['properties'][ $c_name ][ $p_name ] = $mangled;
					if ( $declaring !== $c_name ) {
						$this->private_members['properties'][ $declaring ][ $p_name ] = $mangled;
					}
				}
			}
			foreach ( $class['constants'] as $k_name => $meta ) {
				if ( $meta['visibility'] === 'private' && ! isset( $this->preserved_members[ $c_name ]['constants'][ $k_name ] ) ) {
					$declaring = $meta['declaring'];
					$mangled   = '_k_' . substr( hash( 'sha256', $this->seed . ':k:' . $declaring . '::' . $k_name ), 0, 8 );
					$this->private_members['constants'][ $c_name ][ $k_name ] = $mangled;
					if ( $declaring !== $c_name ) {
						$this->private_members['constants'][ $declaring ][ $k_name ] = $mangled;
					}
				}
			}
		}

		// 7. Sanity strip: ensure no preserved member exists in private_members
		foreach ( array( 'methods', 'properties', 'constants' ) as $kind ) {
			if ( ! empty( $this->preserved_members ) ) {
				foreach ( $this->preserved_members as $c_name => $kinds ) {
					if ( isset( $kinds[ $kind ] ) ) {
						foreach ( $kinds[ $kind ] as $mem => $_ ) {
							unset( $this->private_members[ $kind ][ $c_name ][ $mem ] );
						}
					}
				}
			}
		}

		// 5. Finalize Global Variables & Re-check Preserved Decisions
		if ( ! empty( $this->project_global_vars ) ) {
			foreach ( $this->file_var_decisions as $f_path => &$decisions ) {
				foreach ( $decisions as $offset => &$item ) {
					if ( isset( $this->project_global_vars[ $item['var'] ] ) ) {
						$item['action'] = 'preserve';
					}
				}
			}
			unset( $item, $decisions );

			foreach ( $this->file_compact_decisions as $f_path => &$compacts ) {
				foreach ( $compacts as $offset => &$item ) {
					if ( is_array( $item ) && $item[0] === 'rewrite' ) {
						foreach ( $item[1] as $arg ) {
							if ( isset( $this->project_global_vars[ '$' . $arg ] ) ) {
								$item = 'retain';
								break;
							}
						}
					}
				}
			}
			unset( $item, $compacts );
		}
	}
}
